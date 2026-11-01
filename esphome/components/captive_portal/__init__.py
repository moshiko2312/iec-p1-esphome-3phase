# Copied from ESPHome 2026.10.1 (esphome/components/captive_portal, MIT-licensed
# Python). Modified for the IEC P1 reader: adds the `page` option and builds the
# page from esphome/ui/portal.html at compile time. See NOTICE.
import gzip
import logging
from pathlib import Path

import esphome.codegen as cg
from esphome.components import web_server_base, wifi
from esphome.components.web_server_base import CONF_WEB_SERVER_BASE_ID
from esphome.config_helpers import filter_source_files_from_platform
import esphome.config_validation as cv
from esphome.const import (
    CONF_AP,
    CONF_COMPRESSION,
    CONF_ID,
    PLATFORM_BK72XX,
    PLATFORM_ESP32,
    PLATFORM_ESP8266,
    PLATFORM_LN882X,
    PLATFORM_RP2,
    PLATFORM_RTL87XX,
    PlatformFramework,
)
from esphome.core import CORE, coroutine_with_priority
from esphome.coroutine import CoroPriority
import esphome.final_validate as fv
from esphome.types import ConfigType

_LOGGER = logging.getLogger(__name__)


def AUTO_LOAD() -> list[str]:
    auto_load = ["web_server_base", "ota.web_server"]
    if CORE.is_esp32:
        auto_load.append("socket")
    return auto_load


DEPENDENCIES = ["wifi"]
CODEOWNERS = ["@esphome/core"]

captive_portal_ns = cg.esphome_ns.namespace("captive_portal")
CaptivePortal = captive_portal_ns.class_("CaptivePortal", cg.Component)

CONF_PAGE = "page"
# esphome/components/captive_portal/__init__.py -> esphome/ui/portal.html
DEFAULT_PAGE = Path(__file__).resolve().parent.parent.parent / "ui" / "portal.html"
STOCK_PAGE = Path(__file__).resolve().parent / "stock_portal.html"


def _compress_page(html: bytes, compression: str) -> tuple[bytes, str]:
    """Compress the page; falls back to gzip when the brotli module is missing."""
    if compression == "br":
        try:
            import brotli  # pylint: disable=import-outside-toplevel

            return brotli.compress(html, quality=11), "br"
        except ImportError:
            _LOGGER.warning("captive_portal: brotli module not installed, using gzip")
    return gzip.compress(html, compresslevel=9, mtime=0), "gzip"


def _page_source(config: ConfigType) -> Path:
    page = config.get(CONF_PAGE)
    if page is not None:
        return Path(page)
    if DEFAULT_PAGE.is_file():
        return DEFAULT_PAGE
    _LOGGER.warning(
        "captive_portal: %s not found, using the stock ESPHome page", DEFAULT_PAGE
    )
    return STOCK_PAGE

CONFIG_SCHEMA = cv.All(
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(CaptivePortal),
            cv.GenerateID(CONF_WEB_SERVER_BASE_ID): cv.use_id(
                web_server_base.WebServerBase
            ),
            cv.Optional(CONF_COMPRESSION, default="gzip"): cv.one_of("gzip", "br"),
            # HTML file for the Wi-Fi setup page. Defaults to esphome/ui/portal.html.
            cv.Optional(CONF_PAGE): cv.file_,
        }
    ).extend(cv.COMPONENT_SCHEMA),
    cv.only_on(
        [
            PLATFORM_ESP32,
            PLATFORM_ESP8266,
            PLATFORM_BK72XX,
            PLATFORM_LN882X,
            PLATFORM_RP2,
            PLATFORM_RTL87XX,
        ]
    ),
)


def _final_validate(config: ConfigType) -> None:
    full_config = fv.full_config.get()
    wifi_conf = full_config.get("wifi")

    if wifi_conf is None:
        # This shouldn't happen due to DEPENDENCIES = ["wifi"], but check anyway
        raise cv.Invalid("Captive portal requires the wifi component to be configured")

    if CONF_AP not in wifi_conf:
        _LOGGER.warning(
            "Captive portal is enabled but no WiFi AP is configured. "
            "The captive portal will not be accessible. "
            "Add 'ap:' to your WiFi configuration to enable the captive portal."
        )

    # Register socket needs for DNS server and additional HTTP connections
    # - 1 UDP socket for DNS server
    # - 3 TCP sockets for captive portal detection probes + configuration requests
    #   OS captive portal detection makes multiple probe requests that stay in TIME_WAIT.
    #   Need headroom for actual user configuration requests.
    #   LRU purging will reclaim idle sockets to prevent exhaustion from repeated attempts.
    # The listening socket is registered by web_server_base (shared HTTP server).
    from esphome.components import socket

    socket.consume_sockets(3, "captive_portal")(config)
    socket.consume_sockets(1, "captive_portal", socket.SocketType.UDP)(config)


FINAL_VALIDATE_SCHEMA = _final_validate


@coroutine_with_priority(CoroPriority.CAPTIVE_PORTAL)
async def to_code(config: ConfigType) -> None:
    paren = await cg.get_variable(config[CONF_WEB_SERVER_BASE_ID])

    var = cg.new_Pvariable(config[CONF_ID], paren)
    await cg.register_component(var, config)
    cg.add_define("USE_CAPTIVE_PORTAL")
    # The portal reads wifi scan results from the web server task; this makes the
    # wifi component guard them with a lock on multi-threaded platforms.
    wifi.request_wifi_scan_results_lock()

    source = _page_source(config)
    data, used = _compress_page(source.read_bytes(), config[CONF_COMPRESSION])
    if used == "gzip":
        cg.add_define("USE_CAPTIVE_PORTAL_GZIP")
    _LOGGER.info(
        "captive_portal: page %s (%d bytes %s)", source.name, len(data), used
    )
    rows = ",\n".join(
        "    " + ", ".join(f"0x{b:02x}" for b in data[i : i + 24])
        for i in range(0, len(data), 24)
    )
    cg.add_global(
        cg.RawStatement(
            "namespace esphome::captive_portal {\n"
            "extern const uint8_t INDEX_GZ[];\n"
            "extern const size_t INDEX_GZ_SIZE;\n"
            f"const uint8_t INDEX_GZ[] PROGMEM = {{\n{rows}}};\n"
            "const size_t INDEX_GZ_SIZE = sizeof(INDEX_GZ);\n"
            "}  // namespace esphome::captive_portal"
        )
    )

    if CORE.using_arduino and (CORE.is_esp8266 or CORE.is_libretiny or CORE.is_rp2):
        cg.add_library("DNSServer", None)


# Only compile the ESP-IDF DNS server when using ESP-IDF framework
FILTER_SOURCE_FILES = filter_source_files_from_platform(
    {
        "dns_server_esp32_idf.cpp": {
            PlatformFramework.ESP32_ARDUINO,
            PlatformFramework.ESP32_IDF,
        },
    }
)
