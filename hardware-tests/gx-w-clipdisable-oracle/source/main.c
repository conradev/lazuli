// SPDX-License-Identifier: GPL-3.0-only
//
// Empirical GX W-plane / XF ClipDisable oracle.
//
// This program intentionally contains no expected pixel results. It emits raw
// console observations into a fixed MEM1 mailbox and, when FAT is available,
// writes the same mailbox plus compact JSONL signatures to storage.

#include <fat.h>
#include <ogc/cache.h>
#include <ogc/consol.h>
#include <ogc/gu.h>
#include <ogc/gx.h>
#include <ogc/pad.h>
#include <ogc/system.h>
#include <ogc/video.h>

#include <inttypes.h>
#include <malloc.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ORACLE_MAGIC 0x47585731u /* "GXW1" */
#define ORACLE_VERSION 1u
#define ORACLE_ENDIAN_TAG 0x01020304u
#define ORACLE_STATUS_INITIAL 0u
#define ORACLE_STATUS_RUNNING 1u
#define ORACLE_STATUS_COMPLETE 2u
#define ORACLE_STATUS_FAILED 3u

#define ORACLE_WIDTH 16u
#define ORACLE_HEIGHT 16u
#define ORACLE_PIXELS (ORACLE_WIDTH * ORACLE_HEIGHT)
#define ORACLE_CASE_COUNT 10u
#define ORACLE_MODE_COUNT 8u
#define ORACLE_RESULT_COUNT (ORACLE_CASE_COUNT * ORACLE_MODE_COUNT)
#define ORACLE_HEADER_BYTES 64u
#define ORACLE_ENTRY_BYTES 1184u
#define ORACLE_MAILBOX_BYTES 94784u
#define ORACLE_MAILBOX_ADDRESS 0x81700000u

#define FIFO_BYTES (256u * 1024u)
#define COPY_BYTES (ORACLE_PIXELS * 4u)

#define F32_POS_ZERO 0x00000000u
#define F32_NEG_ZERO 0x80000000u
#define F32_POS_QUARTER 0x3e800000u
#define F32_NEG_QUARTER 0xbe800000u
#define F32_POS_HALF 0x3f000000u
#define F32_NEG_HALF 0xbf000000u
#define F32_POS_FIVE_EIGHTHS 0x3f200000u
#define F32_NEG_FIVE_EIGHTHS 0xbf200000u
#define F32_POS_ONE 0x3f800000u
#define F32_NEG_ONE 0xbf800000u
#define F32_POS_TWO_POW_NEG_20 0x35800000u
#define F32_NEG_TWO_POW_NEG_20 0xb5800000u
#define F32_POS_TWO_POW_NEG_21 0x35000000u
#define F32_NEG_TWO_POW_NEG_21 0xb5000000u

typedef struct
{
  uint32_t case_id;
  uint32_t clip_disable;
  uint32_t clip_bits[3][4];
  uint32_t rgba_fnv1a64_hi;
  uint32_t rgba_fnv1a64_lo;
  uint32_t covered_pixels;
  uint32_t unexpected_pixels;
  uint32_t row_masks[ORACLE_HEIGHT];
  uint32_t rgba[ORACLE_PIXELS];
  uint32_t reserved[6];
} OracleEntry;

typedef struct
{
  uint32_t magic;
  uint32_t version;
  uint32_t endian_tag;
  uint32_t header_bytes;
  uint32_t entry_bytes;
  uint32_t width;
  uint32_t height;
  uint32_t case_count;
  uint32_t mode_count;
  uint32_t result_count;
  uint32_t status;
  uint32_t mailbox_bytes;
  uint32_t entries_fnv1a64_hi;
  uint32_t entries_fnv1a64_lo;
  uint32_t reserved[2];
} OracleHeader;

typedef struct
{
  OracleHeader header;
  OracleEntry entries[ORACLE_RESULT_COUNT];
} OracleMailbox;

typedef struct
{
  uint32_t id;
  const char* name;
  uint32_t clip_bits[3][4];
} OracleCase;

_Static_assert(sizeof(OracleHeader) == ORACLE_HEADER_BYTES, "oracle header layout changed");
_Static_assert(sizeof(OracleEntry) == ORACLE_ENTRY_BYTES, "oracle entry layout changed");
_Static_assert(sizeof(OracleMailbox) == ORACLE_MAILBOX_BYTES, "oracle mailbox layout changed");

#if defined(ORACLE_HOST_SYNTAX)
#define ORACLE_MAILBOX_ATTRIBUTES __attribute__((aligned(32), used))
#else
#define ORACLE_MAILBOX_ATTRIBUTES \
  __attribute__((section(".oracle_mailbox"), aligned(32), used))
#endif

ORACLE_MAILBOX_ATTRIBUTES
OracleMailbox g_oracle_mailbox = {
    .header =
        {
            .magic = ORACLE_MAGIC,
            .version = ORACLE_VERSION,
            .endian_tag = ORACLE_ENDIAN_TAG,
            .header_bytes = ORACLE_HEADER_BYTES,
            .entry_bytes = ORACLE_ENTRY_BYTES,
            .width = ORACLE_WIDTH,
            .height = ORACLE_HEIGHT,
            .case_count = ORACLE_CASE_COUNT,
            .mode_count = ORACLE_MODE_COUNT,
            .result_count = 0,
            .status = ORACLE_STATUS_INITIAL,
            .mailbox_bytes = ORACLE_MAILBOX_BYTES,
        },
};

static uint8_t g_copy_buffer[COPY_BYTES] __attribute__((aligned(32)));
static void* g_xfb;
static GXRModeObj* g_rmode;

static const OracleCase ORACLE_CASES[ORACLE_CASE_COUNT] = {
    {
        0,
        "positive-unit-control",
        {
            {F32_NEG_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
            {F32_POS_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
            {F32_POS_ZERO, F32_POS_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
        },
    },
    {
        1,
        "positive-tiny-apex",
        {
            {F32_POS_ZERO, F32_POS_ZERO, F32_NEG_TWO_POW_NEG_21, F32_POS_TWO_POW_NEG_20},
            {F32_NEG_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
            {F32_POS_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
        },
    },
    {
        2,
        "positive-zero-apex",
        {
            {F32_POS_ZERO, F32_POS_QUARTER, F32_NEG_ZERO, F32_POS_ZERO},
            {F32_NEG_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
            {F32_POS_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
        },
    },
    {
        3,
        "negative-zero-apex",
        {
            {F32_POS_ZERO, F32_POS_QUARTER, F32_POS_ZERO, F32_NEG_ZERO},
            {F32_NEG_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
            {F32_POS_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
        },
    },
    {
        4,
        "negative-tiny-apex",
        {
            {F32_POS_ZERO, F32_POS_ZERO, F32_POS_TWO_POW_NEG_21, F32_NEG_TWO_POW_NEG_20},
            {F32_NEG_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
            {F32_POS_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
        },
    },
    {
        5,
        "negative-unit-apex",
        {
            {F32_POS_ZERO, F32_POS_ZERO, F32_POS_HALF, F32_NEG_ONE},
            {F32_NEG_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
            {F32_POS_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
        },
    },
    {
        6,
        "negative-unit-offset-apex",
        {
            {F32_NEG_QUARTER, F32_POS_QUARTER, F32_POS_HALF, F32_NEG_ONE},
            {F32_NEG_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
            {F32_POS_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
        },
    },
    {
        7,
        "two-negative-one-positive",
        {
            {F32_NEG_QUARTER, F32_NEG_QUARTER, F32_POS_HALF, F32_NEG_ONE},
            {F32_POS_QUARTER, F32_NEG_QUARTER, F32_POS_HALF, F32_NEG_ONE},
            {F32_POS_ZERO, F32_POS_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
        },
    },
    {
        8,
        "all-negative",
        {
            {F32_NEG_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_POS_HALF, F32_NEG_ONE},
            {F32_POS_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_POS_HALF, F32_NEG_ONE},
            {F32_POS_ZERO, F32_POS_FIVE_EIGHTHS, F32_POS_HALF, F32_NEG_ONE},
        },
    },
    {
        9,
        "negative-zero-positive",
        {
            {F32_NEG_QUARTER, F32_NEG_QUARTER, F32_POS_HALF, F32_NEG_ONE},
            {F32_POS_ZERO, F32_POS_QUARTER, F32_NEG_ZERO, F32_POS_ZERO},
            {F32_POS_FIVE_EIGHTHS, F32_NEG_FIVE_EIGHTHS, F32_NEG_HALF, F32_POS_ONE},
        },
    },
};

static float f32_from_bits(uint32_t bits)
{
  float value;
  memcpy(&value, &bits, sizeof(value));
  return value;
}

static uint64_t fnv1a64(const void* data, size_t length)
{
  const uint8_t* bytes = data;
  uint64_t hash = UINT64_C(0xcbf29ce484222325);
  for (size_t index = 0; index < length; ++index)
  {
    hash ^= bytes[index];
    hash *= UINT64_C(0x100000001b3);
  }
  return hash;
}

static void set_clip_disable(uint32_t mode)
{
  // GX FIFO command 0x10 loads one XF register. 0x1005 is ClipDisable.
  wgPipe->U8 = 0x10;
  wgPipe->U32 = 0x00001005;
  wgPipe->U32 = mode & 7u;
}

static void load_safe_orthographic_projection(void)
{
  Mtx44 projection;
  memset(projection, 0, sizeof(projection));
  projection[0][0] = 1.0f;
  projection[1][1] = 1.0f;
  projection[2][3] = -0.5f;
  GX_LoadProjectionMtx(projection, GX_ORTHOGRAPHIC);
}

static void load_w_projection(void)
{
  // Raw GX perspective mapping:
  //   clip.x = view.x
  //   clip.y = view.y
  //   clip.z = 0.5 * view.z
  //   clip.w = -view.z
  Mtx44 projection;
  memset(projection, 0, sizeof(projection));
  projection[0][0] = 1.0f;
  projection[1][1] = 1.0f;
  projection[2][2] = 0.5f;
  projection[3][2] = -1.0f;
  GX_LoadProjectionMtx(projection, GX_PERSPECTIVE);
}

static void draw_vertex(uint32_t x_bits, uint32_t y_bits, uint32_t w_bits, GXColor color)
{
  // Perspective GX projection always creates W as -view.z. Flipping the
  // source sign bit requests the exact W bit pattern, including signed zero.
  const uint32_t view_z_bits = w_bits ^ 0x80000000u;
  GX_Position3f32(f32_from_bits(x_bits), f32_from_bits(y_bits), f32_from_bits(view_z_bits));
  GX_Color4u8(color.r, color.g, color.b, color.a);
}

static void clear_oracle_surface(void)
{
  const GXColor black = {0, 0, 0, 255};
  load_safe_orthographic_projection();
  set_clip_disable(0);

  GX_Begin(GX_QUADS, GX_VTXFMT0, 4);
  draw_vertex(F32_NEG_ONE, F32_NEG_ONE, F32_POS_ONE, black);
  draw_vertex(F32_POS_ONE, F32_NEG_ONE, F32_POS_ONE, black);
  draw_vertex(F32_POS_ONE, F32_POS_ONE, F32_POS_ONE, black);
  draw_vertex(F32_NEG_ONE, F32_POS_ONE, F32_POS_ONE, black);
  GX_End();
}

static void draw_oracle_case(const OracleCase* oracle_case, uint32_t mode)
{
  const GXColor red = {255, 0, 0, 255};
  load_w_projection();
  set_clip_disable(mode);

  GX_Begin(GX_TRIANGLES, GX_VTXFMT0, 3);
  for (uint32_t vertex = 0; vertex < 3; ++vertex)
  {
    draw_vertex(oracle_case->clip_bits[vertex][0], oracle_case->clip_bits[vertex][1],
                oracle_case->clip_bits[vertex][3], red);
  }
  GX_End();
}

static void copy_oracle_surface(void)
{
  memset(g_copy_buffer, 0, sizeof(g_copy_buffer));
  DCFlushRange(g_copy_buffer, sizeof(g_copy_buffer));

  GX_SetTexCopySrc(0, 0, ORACLE_WIDTH, ORACLE_HEIGHT);
  GX_SetTexCopyDst(ORACLE_WIDTH, ORACLE_HEIGHT, GX_TF_RGBA8, GX_FALSE);
  GX_CopyTex(g_copy_buffer, GX_FALSE);
  GX_PixModeSync();
  GX_DrawDone();

  DCInvalidateRange(g_copy_buffer, sizeof(g_copy_buffer));
}

static uint32_t rgba8_copy_pixel(uint32_t x, uint32_t y)
{
  const uint32_t blocks_x = (ORACLE_WIDTH + 3u) / 4u;
  const uint32_t block = (y / 4u) * blocks_x + (x / 4u);
  const uint32_t in_block = (y % 4u) * 4u + (x % 4u);
  const uint32_t ar = block * 64u + in_block * 2u;
  const uint32_t gb = ar + 32u;
  const uint8_t a = g_copy_buffer[ar];
  const uint8_t r = g_copy_buffer[ar + 1u];
  const uint8_t g = g_copy_buffer[gb];
  const uint8_t b = g_copy_buffer[gb + 1u];
  return ((uint32_t)r << 24) | ((uint32_t)g << 16) | ((uint32_t)b << 8) | a;
}

static void record_result(OracleEntry* entry, const OracleCase* oracle_case, uint32_t mode)
{
  memset(entry, 0, sizeof(*entry));
  entry->case_id = oracle_case->id;
  entry->clip_disable = mode;
  memcpy(entry->clip_bits, oracle_case->clip_bits, sizeof(entry->clip_bits));

  for (uint32_t y = 0; y < ORACLE_HEIGHT; ++y)
  {
    uint32_t row_mask = 0;
    for (uint32_t x = 0; x < ORACLE_WIDTH; ++x)
    {
      const uint32_t rgba = rgba8_copy_pixel(x, y);
      const uint32_t pixel = y * ORACLE_WIDTH + x;
      const uint8_t r = rgba >> 24;
      const uint8_t g = rgba >> 16;
      const uint8_t b = rgba >> 8;
      const uint8_t a = rgba;
      const bool covered = r > 127u && g < 64u && b < 64u;
      const bool exact_black = r == 0u && g == 0u && b == 0u && a == 255u;
      const bool exact_red = r == 255u && g == 0u && b == 0u && a == 255u;

      entry->rgba[pixel] = rgba;
      if (covered)
      {
        row_mask |= 1u << x;
        ++entry->covered_pixels;
      }
      if (!exact_black && !exact_red)
        ++entry->unexpected_pixels;
    }
    entry->row_masks[y] = row_mask;
  }

  const uint64_t hash = fnv1a64(entry->rgba, sizeof(entry->rgba));
  entry->rgba_fnv1a64_hi = (uint32_t)(hash >> 32);
  entry->rgba_fnv1a64_lo = (uint32_t)hash;
}

static void reset_mailbox(void)
{
  memset(&g_oracle_mailbox, 0, sizeof(g_oracle_mailbox));
  g_oracle_mailbox.header.magic = ORACLE_MAGIC;
  g_oracle_mailbox.header.version = ORACLE_VERSION;
  g_oracle_mailbox.header.endian_tag = ORACLE_ENDIAN_TAG;
  g_oracle_mailbox.header.header_bytes = ORACLE_HEADER_BYTES;
  g_oracle_mailbox.header.entry_bytes = ORACLE_ENTRY_BYTES;
  g_oracle_mailbox.header.width = ORACLE_WIDTH;
  g_oracle_mailbox.header.height = ORACLE_HEIGHT;
  g_oracle_mailbox.header.case_count = ORACLE_CASE_COUNT;
  g_oracle_mailbox.header.mode_count = ORACLE_MODE_COUNT;
  g_oracle_mailbox.header.status = ORACLE_STATUS_RUNNING;
  g_oracle_mailbox.header.mailbox_bytes = ORACLE_MAILBOX_BYTES;
  DCStoreRange(&g_oracle_mailbox, sizeof(g_oracle_mailbox));
}

static void finish_mailbox(void)
{
  const uint64_t hash = fnv1a64(g_oracle_mailbox.entries, sizeof(g_oracle_mailbox.entries));
  g_oracle_mailbox.header.entries_fnv1a64_hi = (uint32_t)(hash >> 32);
  g_oracle_mailbox.header.entries_fnv1a64_lo = (uint32_t)hash;
  g_oracle_mailbox.header.result_count = ORACLE_RESULT_COUNT;
  g_oracle_mailbox.header.status = ORACLE_STATUS_COMPLETE;
  DCStoreRange(&g_oracle_mailbox, sizeof(g_oracle_mailbox));
}

static bool write_binary_capture(void)
{
  FILE* output = fopen("gx-w-clipdisable-oracle-v1.bin", "wb");
  if (output == NULL)
    return false;
  const size_t written = fwrite(&g_oracle_mailbox, 1, sizeof(g_oracle_mailbox), output);
  const bool closed = fclose(output) == 0;
  return written == sizeof(g_oracle_mailbox) && closed;
}

static bool write_jsonl_capture(void)
{
  FILE* output = fopen("gx-w-clipdisable-oracle-v1.jsonl", "wb");
  if (output == NULL)
    return false;

  bool ok = true;
  for (uint32_t index = 0; index < ORACLE_RESULT_COUNT; ++index)
  {
    const OracleEntry* entry = &g_oracle_mailbox.entries[index];
    const OracleCase* oracle_case = &ORACLE_CASES[entry->case_id];
    if (fprintf(output,
                "{\"schema\":\"lazuli.gx-w-clipdisable-oracle/v1\","
                "\"caseId\":%" PRIu32 ",\"case\":\"%s\","
                "\"clipDisable\":%" PRIu32 ","
                "\"rgbaFnv1a64\":\"%08" PRIx32 "%08" PRIx32 "\","
                "\"coveredPixels\":%" PRIu32 ","
                "\"unexpectedPixels\":%" PRIu32 ",\"rowMasks\":[",
                entry->case_id, oracle_case->name, entry->clip_disable,
                entry->rgba_fnv1a64_hi, entry->rgba_fnv1a64_lo, entry->covered_pixels,
                entry->unexpected_pixels) < 0)
    {
      ok = false;
      break;
    }
    for (uint32_t y = 0; y < ORACLE_HEIGHT; ++y)
    {
      if (fprintf(output, "%s\"%04" PRIx32 "\"", y == 0 ? "" : ",",
                  entry->row_masks[y] & 0xffffu) < 0)
      {
        ok = false;
        break;
      }
    }
    if (!ok || fprintf(output, "]}\n") < 0)
    {
      ok = false;
      break;
    }
  }

  if (fclose(output) != 0)
    ok = false;
  return ok;
}

static void init_console(void)
{
  VIDEO_Init();
  PAD_Init();
  g_rmode = VIDEO_GetPreferredMode(NULL);
  g_xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(g_rmode));
  console_init(g_xfb, 20, 20, g_rmode->fbWidth, g_rmode->xfbHeight,
               g_rmode->fbWidth * VI_DISPLAY_PIX_SZ);
  VIDEO_Configure(g_rmode);
  VIDEO_SetNextFramebuffer(g_xfb);
  VIDEO_SetBlack(FALSE);
  VIDEO_Flush();
  VIDEO_WaitVSync();
  if (g_rmode->viTVMode & VI_NON_INTERLACE)
    VIDEO_WaitVSync();
  printf("\x1b[2;0H");
}

static bool init_gx(void)
{
  void* fifo = memalign(32, FIFO_BYTES);
  if (fifo == NULL)
    return false;
  memset(fifo, 0, FIFO_BYTES);
  GX_Init(fifo, FIFO_BYTES);

  GX_SetViewport(0.0f, 0.0f, ORACLE_WIDTH, ORACLE_HEIGHT, 0.0f, 1.0f);
  GX_SetScissor(0, 0, ORACLE_WIDTH, ORACLE_HEIGHT);
  GX_SetScissorBoxOffset(0, 0);
  GX_SetCullMode(GX_CULL_NONE);
  GX_SetZMode(GX_DISABLE, GX_ALWAYS, GX_FALSE);
  GX_SetBlendMode(GX_BM_NONE, GX_BL_ONE, GX_BL_ZERO, GX_LO_CLEAR);
  GX_SetAlphaCompare(GX_ALWAYS, 0, GX_AOP_AND, GX_ALWAYS, 0);
  GX_SetColorUpdate(GX_ENABLE);
  GX_SetAlphaUpdate(GX_ENABLE);
  GX_SetDither(GX_DISABLE);
  GX_SetPixelFmt(GX_PF_RGBA6_Z24, GX_ZC_LINEAR);

  GX_ClearVtxDesc();
  GX_SetVtxDesc(GX_VA_POS, GX_DIRECT);
  GX_SetVtxDesc(GX_VA_CLR0, GX_DIRECT);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_POS, GX_POS_XYZ, GX_F32, 0);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_CLR0, GX_CLR_RGBA, GX_RGBA8, 0);

  Mtx identity;
  guMtxIdentity(identity);
  GX_LoadPosMtxImm(identity, GX_PNMTX0);
  GX_SetCurrentMtx(GX_PNMTX0);

  GX_SetNumChans(1);
  GX_SetChanCtrl(GX_COLOR0A0, GX_DISABLE, GX_SRC_VTX, GX_SRC_VTX, 0, GX_DF_NONE, GX_AF_NONE);
  GX_SetNumTexGens(0);
  GX_SetNumTevStages(1);
  GX_SetTevOrder(GX_TEVSTAGE0, GX_TEXCOORDNULL, GX_TEXMAP_NULL, GX_COLOR0A0);
  GX_SetTevOp(GX_TEVSTAGE0, GX_PASSCLR);
  return true;
}

int main(void)
{
  // Keep every libogc allocation below the fixed mailbox near the top of MEM1.
  SYS_SetArena1Hi((void*)ORACLE_MAILBOX_ADDRESS);
  init_console();
  reset_mailbox();

  printf("GX W / ClipDisable oracle v1\n");
  printf("mailbox: 0x%08" PRIx32 " (%" PRIu32 " bytes)\n", ORACLE_MAILBOX_ADDRESS,
         ORACLE_MAILBOX_BYTES);

  if (!init_gx())
  {
    g_oracle_mailbox.header.status = ORACLE_STATUS_FAILED;
    DCStoreRange(&g_oracle_mailbox, sizeof(g_oracle_mailbox));
    printf("ERROR: GX FIFO allocation failed\n");
    return 1;
  }

  uint32_t result_index = 0;
  for (uint32_t case_index = 0; case_index < ORACLE_CASE_COUNT; ++case_index)
  {
    const OracleCase* oracle_case = &ORACLE_CASES[case_index];
    for (uint32_t mode = 0; mode < ORACLE_MODE_COUNT; ++mode)
    {
      clear_oracle_surface();
      draw_oracle_case(oracle_case, mode);
      copy_oracle_surface();
      record_result(&g_oracle_mailbox.entries[result_index], oracle_case, mode);
      ++result_index;
      g_oracle_mailbox.header.result_count = result_index;
      DCStoreRange(&g_oracle_mailbox, ORACLE_HEADER_BYTES + result_index * ORACLE_ENTRY_BYTES);
    }
  }
  finish_mailbox();

  bool binary_saved = false;
  bool jsonl_saved = false;
  if (fatInitDefault())
  {
    binary_saved = write_binary_capture();
    jsonl_saved = write_jsonl_capture();
  }

  printf("complete: %" PRIu32 " observations\n", g_oracle_mailbox.header.result_count);
  printf("entries fnv1a64: %08" PRIx32 "%08" PRIx32 "\n",
         g_oracle_mailbox.header.entries_fnv1a64_hi,
         g_oracle_mailbox.header.entries_fnv1a64_lo);
  printf("FAT binary: %s; JSONL: %s\n", binary_saved ? "saved" : "unavailable",
         jsonl_saved ? "saved" : "unavailable");
  printf("Press START to return.\n");

  while (SYS_MainLoop())
  {
    PAD_ScanPads();
    if (PAD_ButtonsDown(0) & PAD_BUTTON_START)
      break;
    VIDEO_WaitVSync();
  }
  return 0;
}
