// Copied from ESPHome 2026.10.1 (esphome/components/captive_portal), licensed under
// the GNU General Public License v3.0. Modified for the IEC P1 reader. See NOTICE.
//
// The page bytes are no longer stored here. __init__.py compresses
// esphome/ui/portal.html during the build and defines INDEX_GZ / INDEX_GZ_SIZE
// in main.cpp (gzip or brotli, matching USE_CAPTIVE_PORTAL_GZIP).
#pragma once

#include <cstddef>
#include <cstdint>

#include "esphome/core/hal.h"

namespace esphome::captive_portal {

extern const uint8_t INDEX_GZ[];
extern const size_t INDEX_GZ_SIZE;

}  // namespace esphome::captive_portal
