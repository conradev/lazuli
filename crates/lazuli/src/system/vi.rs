//! Video interface (VI).
use bitos::bitos;
use bitos::integer::{u4, u7, u9, u10, u24};
use gekko::{Address, FREQUENCY};

use crate::modules::render;
use crate::system::scheduler::{MachineEventDeadlines, MachineEventKind};
use crate::system::{System, pi, si};

const VI_CLOCK_FREQUENCIES: [u64; 2] = [27_000_000, 54_000_000];
const SCANOUT_BOUNDARY_CAPACITY: usize = 8;

#[bitos(16)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VerticalTiming {
    /// Length of the equalization pulse, in halflines.
    #[bits(0..4)]
    pub equalization_pulse: u4,
    /// Amount of lines in the active video of a field.
    #[bits(4..14)]
    pub active_video_lines: u10,
}

#[bitos(2)]
#[derive(Debug, Clone, Copy, Default)]
pub enum DisplayLatchMode {
    #[default]
    Off    = 0,
    Once   = 1,
    Twice  = 2,
    Always = 3,
}

#[bitos(2)]
#[derive(Debug, Clone, Copy, Default)]
pub enum VideoFormat {
    #[default]
    NTSC  = 0,
    Pal50 = 1,
    Pal60 = 2,
    Debug = 3,
}

#[bitos(1)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FieldMode {
    /// Interlaced rendering: both fields are used.
    #[default]
    Double = 0,
    /// Non-interlaced rendering: only one field is used. Also known as "double-strike".
    Single = 1,
}

#[bitos(16)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DisplayConfig {
    /// Enable video timing generation and data request.
    #[bits(0)]
    pub enable: bool,
    /// Clears all data requests and puts the interface into its idle state.
    #[bits(1)]
    pub reset: bool,
    /// The current field mode.
    #[bits(2)]
    pub field_mode: FieldMode,
    /// Current video format.
    #[bits(8..10)]
    pub video_format: VideoFormat,
}

#[bitos(64)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HorizontalTiming {
    // HTR1
    /// Width of the HSync pulse, in samples.
    #[bits(0..7)]
    pub sync_width: u7,
    /// Amount of samples between the start of HSync pulse and HBlank end.
    #[bits(7..17)]
    pub sync_start_to_blank_end: u10,
    /// Amount of samples between the half of the line and HBlank start.
    #[bits(17..27)]
    pub halfline_to_blank_start: u10,

    // HTR0
    /// Width of a halfline, in samples.
    #[bits(32..42)]
    pub halfline_width: u10,
    /// Amount of samples between the start of HSync pulse and color burst end.
    #[bits(48..55)]
    pub sync_start_to_color_burst_end: u7,
    /// Amount of samples between the start of HSync pulse and color burst start.
    #[bits(56..63)]
    pub sync_start_to_color_burst_start: u7,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FieldVerticalTiming {
    /// Length of the pre-blanking interval in half-lines.
    #[bits(0..10)]
    pub pre_blanking: u10,
    /// Length of the post-blanking interval in half-lines.
    #[bits(16..26)]
    pub post_blanking: u10,
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FieldBase {
    /// Bits 0..24 of the XFB address for this field.
    #[bits(0..24)]
    pub xfb_address_base: u24,
    #[bits(24..28)]
    pub horizontal_offset: u4,
    /// If set, shifts XFB address right by 5.
    #[bits(28)]
    pub shift_xfb_addr: bool,
}

impl FieldBase {
    /// Physical address of the XFB when this register owns the shared POFF line.
    ///
    /// POFF makes the packed 24-bit base use 32-byte units. Older native code shifted in the
    /// opposite direction; the browser compatibility path proved that the hardware behavior is
    /// a left shift.
    pub fn xfb_address(&self) -> Address {
        Address(
            self.xfb_address_base()
                .value()
                .wrapping_shl(5 * u32::from(self.shift_xfb_addr())),
        )
    }
}

#[bitos(32)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DisplayInterrupt {
    /// Sample count for the interrupt.
    #[bits(0..10)]
    pub horizontal_count: u10,
    /// Line count for the interrupt.
    #[bits(16..26)]
    pub vertical_count: u10,
    /// Whether this interrupt is enabled.
    #[bits(28)]
    pub enable: bool,
    /// Whether this interrupt is asserted. Clear on write.
    #[bits(31)]
    pub status: bool,
}

#[bitos(16)]
#[derive(Debug, Clone, Copy, Default)]
pub struct HorizontalScaling {
    #[bits(0..9)]
    pub step_size: u9,
    #[bits(12)]
    pub enabled: bool,
}

#[bitos(16)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExternalFramebufferWidth {
    /// Stride of the XFB divided by 16.
    #[bits(0..8)]
    pub stride_div_16: u8,
    /// Width of the XFB divided by 16.
    #[bits(8..15)]
    pub width_div_16: u7,
}

impl ExternalFramebufferWidth {
    /// Stride of the XFB.
    pub fn stride(&self) -> u16 {
        self.stride_div_16() as u16 * 16
    }

    /// Width of the XFB.
    pub fn width(&self) -> u16 {
        self.width_div_16().value() as u16 * 16
    }
}

#[bitos(16)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClockMode {
    #[bits(0)]
    pub double: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoMode {
    NonInterlaced,
    Interlaced,
    Progressive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dimensions {
    pub width: u16,
    pub height: u16,
}

impl Dimensions {
    pub fn is_degenerate(self) -> bool {
        self.width == 0 || self.height == 0
    }
}

/// Field selected by one VI raster boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Top,
    Bottom,
}

/// Exact integer timing decoded from the programmed VI registers and their field-latched image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RasterTiming {
    pub display_enabled: bool,
    pub single_field: bool,
    pub equalization_pulse: u16,
    pub active_video_lines: u16,
    pub halfline_width: u16,
    pub top_pre_blanking: u16,
    pub top_post_blanking: u16,
    pub bottom_pre_blanking: u16,
    pub bottom_post_blanking: u16,
    pub clock_hz: u64,
    pub cycles_per_sample: u64,
    pub cycles_per_halfline: u64,
    pub top_halflines: u32,
    pub bottom_halflines: u32,
    pub total_halflines: u32,
    pub frame_cycles: u64,
}

/// Guest-visible raster coordinates at one exact CPU cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BeamPosition {
    pub halfline: u32,
    pub vertical_count: u16,
    pub horizontal_count: u16,
    pub sample: u16,
}

/// Validated comparator coordinates and their linear sample within a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComparatorTarget {
    pub horizontal_count: u16,
    pub vertical_count: u16,
    pub target_sample: u64,
    pub halfline: u32,
    pub sample: u16,
}

/// How the browser adapter should expand one field into output rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanoutPolicy {
    Bob,
    Direct,
}

/// VI-owned output geometry. Resolving an address to a renderer texture is deliberately not part
/// of this type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanoutDimensions {
    pub picture_configuration: u16,
    pub words_per_line: u16,
    pub standard_words_per_line: u16,
    pub active_lines: u16,
    pub width: u16,
    pub field_stride_bytes: u32,
    pub field_height: u16,
    pub row_repeat: u8,
    pub height: u16,
    pub policy: ScanoutPolicy,
}

impl ScanoutDimensions {
    #[must_use]
    pub fn decode(
        picture_configuration: u16,
        display_config: DisplayConfig,
        active_lines: u16,
    ) -> Self {
        let words_per_line = (picture_configuration >> 8) & 0x7f;
        let standard_words_per_line = picture_configuration & 0xff;
        let single_field = display_config.field_mode() == FieldMode::Single;
        let row_repeat = if single_field { 1 } else { 2 };
        Self {
            picture_configuration,
            words_per_line,
            standard_words_per_line,
            active_lines,
            width: words_per_line * 16,
            field_stride_bytes: u32::from(standard_words_per_line) * 32,
            field_height: active_lines,
            row_repeat,
            height: active_lines * u16::from(row_repeat),
            policy: if single_field {
                ScanoutPolicy::Direct
            } else {
                ScanoutPolicy::Bob
            },
        }
    }
}

/// Provenance of a guest-visible scanout register write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanoutWrite {
    pub value: u32,
    pub write_cycle: u64,
    pub write_serial: u64,
}

/// Immutable field-boundary sample of a scanout register.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanoutLatch {
    pub value: u32,
    pub write_cycle: u64,
    pub write_serial: u64,
    pub field: Field,
    pub latched_at_cycle: u64,
    pub latch_serial: u64,
    /// BFBL samples TFBL's shared POFF line at the bottom-field boundary.
    pub page_offset_raw: Option<u32>,
    /// Picture-configuration latches also own the field geometry used by presentation.
    pub display_config: Option<DisplayConfig>,
    pub active_lines: Option<u16>,
    pub top_vertical_timing: Option<FieldVerticalTiming>,
}

/// Complete VI-owned state captured at an active-field boundary.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScanoutSnapshot {
    pub top_base: Option<ScanoutLatch>,
    pub bottom_base: Option<ScanoutLatch>,
    pub picture: Option<ScanoutLatch>,
}

/// Synchronous field work returned to a future thin browser/renderer adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScanoutWork {
    pub scheduled_cycle: u64,
    pub observed_cycle: u64,
    pub cycles_late: u64,
    pub field: Field,
    pub address: Option<Address>,
    pub dimensions: ScanoutDimensions,
    pub snapshot: ScanoutSnapshot,
}

/// The four scalar deadlines owned by VI in the resident machine loop.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ResidentDeadlines {
    pub comparator: Option<u64>,
    pub presentation: Option<u64>,
    pub scanout_boundary: Option<u64>,
    pub timing_boundary: Option<u64>,
}

/// Evidence from one exact overdue VI drain.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ServiceSummary {
    pub comparator_events: u64,
    pub timing_boundaries: u64,
    pub scanout_boundaries: u64,
    pub comparator_match_mask: u8,
    pub last_scheduled_cycle: Option<u64>,
    pub interrupt_level_active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentError {
    TimingOverflow,
    CycleOverflow,
    CounterOverflow,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct FrozenBeam {
    halfline: u32,
    sample: u16,
    sample_cycle: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct ScanoutRegisters {
    top_base: Option<ScanoutWrite>,
    bottom_base: Option<ScanoutWrite>,
    picture: Option<ScanoutWrite>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScanoutBoundary {
    scheduled_cycle: u64,
    field: Field,
    snapshot: ScanoutSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ScanoutBoundaryQueue {
    entries: [Option<ScanoutBoundary>; SCANOUT_BOUNDARY_CAPACITY],
    head: usize,
    len: usize,
}

impl Default for ScanoutBoundaryQueue {
    fn default() -> Self {
        Self {
            entries: [None; SCANOUT_BOUNDARY_CAPACITY],
            head: 0,
            len: 0,
        }
    }
}

impl ScanoutBoundaryQueue {
    fn clear(&mut self) {
        self.entries = [None; SCANOUT_BOUNDARY_CAPACITY];
        self.head = 0;
        self.len = 0;
    }

    fn push(&mut self, boundary: ScanoutBoundary) {
        if self.len == SCANOUT_BOUNDARY_CAPACITY {
            self.entries[self.head] = Some(boundary);
            self.head = (self.head + 1) % SCANOUT_BOUNDARY_CAPACITY;
            return;
        }
        let tail = (self.head + self.len) % SCANOUT_BOUNDARY_CAPACITY;
        self.entries[tail] = Some(boundary);
        self.len += 1;
    }

    fn front(&self) -> Option<ScanoutBoundary> {
        (self.len != 0).then(|| self.entries[self.head]).flatten()
    }

    fn pop_front(&mut self) -> Option<ScanoutBoundary> {
        let boundary = self.front()?;
        self.entries[self.head] = None;
        self.head = (self.head + 1) % SCANOUT_BOUNDARY_CAPACITY;
        self.len -= 1;
        Some(boundary)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResidentState {
    timing: Option<RasterTiming>,
    schedule_dirty: bool,
    // Browser timing can preserve a phase whose halfline origin predates machine cycle zero
    // (for example, an early 54 -> 27 MHz clock switch). Published deadlines stay u64; only this
    // internal modular origin is signed.
    epoch_cycle: i128,
    epoch_halfline: u32,
    beam_enabled: bool,
    frozen_beam: FrozenBeam,
    deadlines: ResidentDeadlines,
    comparator_signature: [u32; 4],
    active_video_lines: Option<u16>,
    pending_video_lines: Option<u16>,
    active_top_vertical_timing: Option<FieldVerticalTiming>,
    pending_top_vertical_timing: Option<FieldVerticalTiming>,
    active_bottom_vertical_timing: Option<FieldVerticalTiming>,
    pending_bottom_vertical_timing: Option<FieldVerticalTiming>,
    scanout_write_serial: u64,
    scanout_latch_serial: u64,
    scanout_pending: ScanoutRegisters,
    scanout_active: ScanoutSnapshot,
    scanout_boundaries: ScanoutBoundaryQueue,
    timing_reschedules: u64,
    missed_halflines: u64,
    comparator_matches: [u64; 4],
    status_assertions: [u64; 4],
    interrupt_acknowledgements: [u64; 4],
}

impl Default for ResidentState {
    fn default() -> Self {
        Self {
            timing: None,
            schedule_dirty: true,
            epoch_cycle: 0,
            epoch_halfline: 0,
            beam_enabled: false,
            frozen_beam: FrozenBeam::default(),
            deadlines: ResidentDeadlines::default(),
            comparator_signature: [u32::MAX; 4],
            active_video_lines: None,
            pending_video_lines: None,
            active_top_vertical_timing: None,
            pending_top_vertical_timing: None,
            active_bottom_vertical_timing: None,
            pending_bottom_vertical_timing: None,
            scanout_write_serial: 0,
            scanout_latch_serial: 0,
            scanout_pending: ScanoutRegisters::default(),
            scanout_active: ScanoutSnapshot::default(),
            scanout_boundaries: ScanoutBoundaryQueue::default(),
            timing_reschedules: 0,
            missed_halflines: 0,
            comparator_matches: [0; 4],
            status_assertions: [0; 4],
            interrupt_acknowledgements: [0; 4],
        }
    }
}

#[derive(Debug, Default)]
pub struct Interface {
    pub display_config: DisplayConfig,
    pub vertical_timing: VerticalTiming,
    pub horizontal_timing: HorizontalTiming,
    pub top_vertical_timing: FieldVerticalTiming,
    pub top_base_left: FieldBase,
    pub top_base_right: u32,
    pub bottom_vertical_timing: FieldVerticalTiming,
    pub bottom_base_left: FieldBase,
    pub bottom_base_right: u32,
    pub vertical_count: u16,
    pub horizontal_count: u16,
    pub interrupts: [DisplayInterrupt; 4],
    pub xfb_width: ExternalFramebufferWidth,
    pub horizontal_scaling: HorizontalScaling,
    pub clock: ClockMode,
    resident: ResidentState,
}

impl Interface {
    #[inline(always)]
    fn elapsed_cycles_from_epoch(&self, observed_cycle: u64) -> u128 {
        let observed_cycle = i128::from(observed_cycle);
        if observed_cycle < self.resident.epoch_cycle {
            0
        } else {
            (observed_cycle - self.resident.epoch_cycle) as u128
        }
    }

    /// The current video clock frequency.
    pub fn video_clock(&self) -> u32 {
        if self.clock.double() {
            54_000_000
        } else {
            27_000_000
        }
    }

    /// How many CPU cycles long a sample (~ pixel) is.
    pub fn cycles_per_sample(&self) -> u32 {
        2 * FREQUENCY as u32 / self.video_clock()
    }

    /// How many CPU cycles long a halfline is.
    pub fn cycles_per_halfline(&self) -> u32 {
        self.cycles_per_sample() * self.horizontal_timing.halfline_width().value() as u32
    }

    /// How many halflines long a top field is.
    pub fn halflines_per_top_field(&self) -> u32 {
        3 * self.vertical_timing.equalization_pulse().value() as u32
            + self.top_vertical_timing.pre_blanking().value() as u32
            + 2 * self.vertical_timing.active_video_lines().value() as u32
            + self.top_vertical_timing.post_blanking().value() as u32
    }

    /// How many halflines long a bottom field is.
    pub fn halflines_per_bottom_field(&self) -> u32 {
        3 * self.vertical_timing.equalization_pulse().value() as u32
            + self.bottom_vertical_timing.pre_blanking().value() as u32
            + 2 * self.vertical_timing.active_video_lines().value() as u32
            + self.bottom_vertical_timing.post_blanking().value() as u32
    }

    /// How many halflines long a single frame is.
    pub fn halflines_per_frame(&self) -> u32 {
        self.halflines_per_top_field()
            + if self.display_config.field_mode() == FieldMode::Double {
                self.halflines_per_bottom_field()
            } else {
                0
            }
    }

    /// How many CPU cycles long a top field is.
    pub fn cycles_per_top_field(&self) -> u32 {
        self.cycles_per_halfline() * self.halflines_per_top_field()
    }

    /// How many CPU cycles long an even field is.
    pub fn cycles_per_bottom_field(&self) -> u32 {
        self.cycles_per_halfline() * self.halflines_per_bottom_field()
    }

    /// How many lines long a frame is.
    pub fn lines_per_frame(&self) -> u32 {
        self.halflines_per_frame() / 2
    }

    /// How many times a field is rendered in a second, on average.
    pub fn field_rate(&self) -> f64 {
        let cycles_per_frame =
            (self.cycles_per_top_field() + self.cycles_per_bottom_field()) as f64 / 2.0;

        FREQUENCY as f64 / cycles_per_frame
    }

    /// The refresh rate of the video output, i.e. how many times a frame is rendered in a second.
    pub fn frame_rate(&self) -> f64 {
        match self.display_config.field_mode() {
            FieldMode::Double => self.field_rate() / 2.0,
            FieldMode::Single => self.field_rate(),
        }
    }

    /// Address of the XFB for the top field.
    pub fn top_xfb_address(&self) -> Address {
        xfb_address_from_raw(self.top_base_left.to_bits(), self.top_base_left.to_bits())
    }

    /// Address of the XFB for the bottom field.
    pub fn bottom_xfb_address(&self) -> Address {
        xfb_address_from_raw(
            self.bottom_base_left.to_bits(),
            self.top_base_left.to_bits(),
        )
    }

    /// Returns the current video mode.
    pub fn video_mode(&self) -> VideoMode {
        if self.clock.double() {
            return VideoMode::Progressive;
        }

        match self.display_config.field_mode() {
            FieldMode::Single => VideoMode::NonInterlaced,
            FieldMode::Double => VideoMode::Interlaced,
        }
    }

    /// Dimensions of an external framebuffer.
    pub fn xfb_dimensions(&self) -> Dimensions {
        let width = self.xfb_width.width();
        let height = self.vertical_timing.active_video_lines().value();

        Dimensions { width, height }
    }

    /// Stride of the rows in an external framebuffer, in pixels.
    pub fn xfb_stride(&self) -> u16 {
        // YCbYCr format has 2 pixels every 4 bytes
        self.xfb_width.stride() / 2
    }

    /// Dimensions of the entire frame, which may consist of either one or two extenral
    /// framebuffers.
    pub fn frame_dimensions(&self) -> Dimensions {
        let xfb = self.xfb_dimensions();
        match self.display_config.field_mode() {
            FieldMode::Double => Dimensions {
                width: xfb.width,
                height: xfb.height * 2,
            },
            FieldMode::Single => xfb,
        }
    }

    /// Height of the video output.
    fn video_height(&self) -> u16 {
        let active_lines = self.vertical_timing.active_video_lines().value();
        let height_multiplier = match self.display_config.field_mode() {
            FieldMode::Double => 2,
            FieldMode::Single => 1,
        };

        height_multiplier * active_lines
    }

    /// Width of the video output.
    fn video_width(&self) -> u16 {
        self.horizontal_timing.halfline_width().value()
            + self.horizontal_timing.halfline_to_blank_start().value()
            - self.horizontal_timing.sync_start_to_blank_end().value()
    }

    /// Dimensions of the video output.
    pub fn video_dimensions(&self) -> Dimensions {
        Dimensions {
            width: self.video_width(),
            height: self.video_height(),
        }
    }

    /// Dimensions of the region in the video output which contain image data.
    pub fn video_dimensions_cropped(&self) -> Dimensions {
        Dimensions {
            width: self.xfb_dimensions().width,
            height: self.video_height(),
        }
    }

    pub fn write_interrupt<const N: usize>(&mut self, new: DisplayInterrupt) {
        const { assert!(N < 4) };
        self.interrupts[N] = new.with_status(self.interrupts[N].status() && new.status());
    }
}

impl Interface {
    /// Current exact resident timing, including field-latched ACV and blanking registers.
    #[must_use]
    pub const fn resident_timing(&self) -> Option<RasterTiming> {
        self.resident.timing
    }

    #[must_use]
    pub const fn resident_deadlines(&self) -> ResidentDeadlines {
        self.resident.deadlines
    }

    #[must_use]
    pub const fn resident_beam_enabled(&self) -> bool {
        self.resident.beam_enabled
    }

    #[must_use]
    pub const fn queued_scanout_boundaries(&self) -> usize {
        self.resident.scanout_boundaries.len
    }

    #[must_use]
    pub const fn active_scanout_snapshot(&self) -> ScanoutSnapshot {
        self.resident.scanout_active
    }

    #[must_use]
    pub const fn resident_timing_reschedules(&self) -> u64 {
        self.resident.timing_reschedules
    }

    #[must_use]
    pub const fn resident_missed_halflines(&self) -> u64 {
        self.resident.missed_halflines
    }

    #[must_use]
    pub const fn resident_comparator_matches(&self) -> [u64; 4] {
        self.resident.comparator_matches
    }

    #[must_use]
    pub const fn resident_status_assertions(&self) -> [u64; 4] {
        self.resident.status_assertions
    }

    #[must_use]
    pub const fn resident_interrupt_acknowledgements(&self) -> [u64; 4] {
        self.resident.interrupt_acknowledgements
    }

    fn decode_resident_timing(&self) -> Result<Option<RasterTiming>, ResidentError> {
        let equalization_pulse = self.vertical_timing.equalization_pulse().value() as u16;
        let active_video_lines = self
            .resident
            .active_video_lines
            .unwrap_or(self.vertical_timing.active_video_lines().value());
        let top = self
            .resident
            .active_top_vertical_timing
            .unwrap_or(self.top_vertical_timing);
        let bottom = self
            .resident
            .active_bottom_vertical_timing
            .unwrap_or(self.bottom_vertical_timing);
        let halfline_width = self.horizontal_timing.halfline_width().value();
        let top_pre_blanking = top.pre_blanking().value();
        let top_post_blanking = top.post_blanking().value();
        let bottom_pre_blanking = bottom.pre_blanking().value();
        let bottom_post_blanking = bottom.post_blanking().value();
        let single_field = self.display_config.field_mode() == FieldMode::Single;
        let clock_hz = VI_CLOCK_FREQUENCIES[usize::from(self.clock.double())];
        let cycles_per_sample = FREQUENCY
            .checked_mul(2)
            .and_then(|cycles| cycles.checked_div(clock_hz))
            .ok_or(ResidentError::TimingOverflow)?;
        let cycles_per_halfline = cycles_per_sample
            .checked_mul(u64::from(halfline_width))
            .ok_or(ResidentError::TimingOverflow)?;

        let field_halflines = |pre: u16, post: u16| {
            u32::from(equalization_pulse)
                .checked_mul(3)
                .and_then(|value| value.checked_add(u32::from(pre)))
                .and_then(|value| {
                    u32::from(active_video_lines)
                        .checked_mul(2)
                        .and_then(|active| value.checked_add(active))
                })
                .and_then(|value| value.checked_add(u32::from(post)))
        };
        let top_halflines = field_halflines(top_pre_blanking, top_post_blanking)
            .ok_or(ResidentError::TimingOverflow)?;
        let bottom_halflines = field_halflines(bottom_pre_blanking, bottom_post_blanking)
            .ok_or(ResidentError::TimingOverflow)?;
        let total_halflines = if single_field {
            top_halflines
        } else {
            top_halflines
                .checked_add(bottom_halflines)
                .ok_or(ResidentError::TimingOverflow)?
        };

        if halfline_width == 0
            || top_halflines == 0
            || (!single_field && bottom_halflines == 0)
            || cycles_per_halfline == 0
            || total_halflines == 0
        {
            return Ok(None);
        }

        let frame_cycles = cycles_per_halfline
            .checked_mul(u64::from(total_halflines))
            .ok_or(ResidentError::TimingOverflow)?;
        Ok(Some(RasterTiming {
            display_enabled: self.display_config.enable(),
            single_field,
            equalization_pulse,
            active_video_lines,
            halfline_width,
            top_pre_blanking,
            top_post_blanking,
            bottom_pre_blanking,
            bottom_post_blanking,
            clock_hz,
            cycles_per_sample,
            cycles_per_halfline,
            top_halflines,
            bottom_halflines,
            total_halflines,
            frame_cycles,
        }))
    }

    fn comparator_signature(&self) -> [u32; 4] {
        self.interrupts
            .map(|interrupt| interrupt.to_bits() & 0x03ff_03ff)
    }

    /// Exact HCT/VCT image at the supplied machine cycle.
    #[must_use]
    pub fn beam_position_at_cycle(&self, observed_cycle: u64) -> BeamPosition {
        let Some(timing) = self.resident.timing else {
            return BeamPosition {
                halfline: 0,
                vertical_count: 1,
                horizontal_count: 1,
                sample: 0,
            };
        };
        let (halfline, sample) = if self.resident.beam_enabled {
            let elapsed_cycles = self.elapsed_cycles_from_epoch(observed_cycle);
            let elapsed_halflines = elapsed_cycles / u128::from(timing.cycles_per_halfline);
            let halfline = (u128::from(self.resident.epoch_halfline)
                + elapsed_halflines % u128::from(timing.total_halflines))
                % u128::from(timing.total_halflines);
            let halfline_cycles = elapsed_cycles % u128::from(timing.cycles_per_halfline);
            let sample = (halfline_cycles / u128::from(timing.cycles_per_sample))
                .min(u128::from(timing.halfline_width - 1));
            (halfline as u32, sample as u16)
        } else {
            (
                self.resident.frozen_beam.halfline % timing.total_halflines,
                self.resident
                    .frozen_beam
                    .sample
                    .min(timing.halfline_width - 1),
            )
        };

        BeamPosition {
            halfline,
            vertical_count: 1 + (halfline / 2) as u16,
            horizontal_count: 1 + (halfline & 1) as u16 * timing.halfline_width + sample,
            sample,
        }
    }

    /// Captures the exact VI phase needed to schedule resident SI polls.
    ///
    /// The anchor is expressed as a future delta rather than exposing VI's signed internal epoch.
    /// This preserves phase across early 54-to-27 MHz transitions whose exact epoch precedes
    /// machine cycle zero, while keeping SI's public cycle domain entirely `u64`.
    #[must_use]
    pub fn serial_timing_at_cycle(&self, observed_cycle: u64) -> Option<si::ViSerialTiming> {
        let timing = self.resident.timing?;
        let beam = self.beam_position_at_cycle(observed_cycle);
        let cycles_into_half_line = if self.resident.beam_enabled {
            (self.elapsed_cycles_from_epoch(observed_cycle)
                % u128::from(timing.cycles_per_halfline)) as u64
        } else {
            u64::from(self.resident.frozen_beam.sample)
                .checked_mul(timing.cycles_per_sample)?
                .checked_add(self.resident.frozen_beam.sample_cycle)?
        };
        Some(si::ViSerialTiming {
            display_enabled: timing.display_enabled && self.resident.beam_enabled,
            anchor_cycle: observed_cycle,
            anchor_half_line: beam.halfline,
            cycles_into_half_line,
            cycles_per_half_line: timing.cycles_per_halfline,
            odd_half_lines: timing.top_halflines,
            total_half_lines: timing.total_halflines,
        })
    }

    fn active_field_targets(timing: RasterTiming) -> [Option<(Field, u32)>; 2] {
        let top = 3 * u32::from(timing.equalization_pulse) + u32::from(timing.top_pre_blanking);
        if timing.single_field {
            return [Some((Field::Top, top)), None];
        }
        // This is the browser-proven odd/even PSB pacing adjustment, simplified algebraically.
        let bottom = (top
            + 2 * u32::from(timing.active_video_lines)
            + 3 * u32::from(timing.equalization_pulse)
            + u32::from(timing.bottom_pre_blanking)
            + u32::from(timing.bottom_post_blanking))
            % timing.total_halflines;
        [Some((Field::Top, top)), Some((Field::Bottom, bottom))]
    }

    fn timing_field_targets(timing: RasterTiming) -> [Option<(Field, u32)>; 2] {
        [
            Some((Field::Top, 0)),
            (!timing.single_field).then_some((Field::Bottom, timing.top_halflines)),
        ]
    }

    fn cycle_for_halfline_after(
        &self,
        target_halfline: u32,
        observed_cycle: u64,
    ) -> Result<Option<u64>, ResidentError> {
        let Some(timing) = self.resident.timing else {
            return Ok(None);
        };
        let elapsed_cycles = self.elapsed_cycles_from_epoch(observed_cycle);
        let elapsed_halflines = elapsed_cycles / u128::from(timing.cycles_per_halfline);
        let boundary_offset = elapsed_halflines
            .checked_mul(u128::from(timing.cycles_per_halfline))
            .and_then(|cycle| i128::try_from(cycle).ok())
            .ok_or(ResidentError::CycleOverflow)?;
        let boundary_cycle = self
            .resident
            .epoch_cycle
            .checked_add(boundary_offset)
            .ok_or(ResidentError::CycleOverflow)?;
        let current_halfline = (u128::from(self.resident.epoch_halfline)
            + elapsed_halflines % u128::from(timing.total_halflines))
            % u128::from(timing.total_halflines);
        let mut distance = (u128::from(target_halfline) + u128::from(timing.total_halflines)
            - current_halfline)
            % u128::from(timing.total_halflines);
        if distance == 0 {
            distance = u128::from(timing.total_halflines);
        }
        let mut candidate = boundary_cycle
            .checked_add(
                distance
                    .checked_mul(u128::from(timing.cycles_per_halfline))
                    .and_then(|cycle| i128::try_from(cycle).ok())
                    .ok_or(ResidentError::CycleOverflow)?,
            )
            .ok_or(ResidentError::CycleOverflow)?;
        if candidate <= i128::from(observed_cycle) {
            candidate = candidate
                .checked_add(i128::from(timing.frame_cycles))
                .ok_or(ResidentError::CycleOverflow)?;
        }
        Ok(Some(
            u64::try_from(candidate).map_err(|_| ResidentError::CycleOverflow)?,
        ))
    }

    /// Decodes one comparator's ten-bit coordinates, ignoring reserved coordinate bit 10.
    #[must_use]
    pub fn comparator_target(&self, interrupt: DisplayInterrupt) -> Option<ComparatorTarget> {
        let timing = self.resident.timing?;
        let raw = interrupt.to_bits();
        let horizontal_count = (raw & 0x03ff) as u16;
        let vertical_count = ((raw >> 16) & 0x03ff) as u16;
        if vertical_count == 0
            || horizontal_count == 0
            || u32::from(horizontal_count) > 2 * u32::from(timing.halfline_width)
        {
            return None;
        }
        let target_sample = (u64::from(vertical_count) - 1) * 2 * u64::from(timing.halfline_width)
            + (u64::from(horizontal_count) - 1);
        let frame_samples = u64::from(timing.total_halflines) * u64::from(timing.halfline_width);
        if target_sample >= frame_samples {
            return None;
        }
        Some(ComparatorTarget {
            horizontal_count,
            vertical_count,
            target_sample,
            halfline: (target_sample / u64::from(timing.halfline_width)) as u32,
            sample: (target_sample % u64::from(timing.halfline_width)) as u16,
        })
    }

    fn cycle_for_raster_sample_after(
        &self,
        target_sample: u64,
        observed_cycle: u64,
    ) -> Result<Option<u64>, ResidentError> {
        let Some(timing) = self.resident.timing else {
            return Ok(None);
        };
        let frame_samples = u64::from(timing.total_halflines)
            .checked_mul(u64::from(timing.halfline_width))
            .ok_or(ResidentError::TimingOverflow)?;
        let epoch_sample = u64::from(self.resident.epoch_halfline)
            .checked_mul(u64::from(timing.halfline_width))
            .ok_or(ResidentError::TimingOverflow)?;
        let elapsed_samples =
            self.elapsed_cycles_from_epoch(observed_cycle) / u128::from(timing.cycles_per_sample);
        let current_sample = (u128::from(epoch_sample)
            + elapsed_samples % u128::from(frame_samples))
            % u128::from(frame_samples);
        let target_sample = u128::from(target_sample);
        let frame_samples = u128::from(frame_samples);
        let mut distance = (target_sample + frame_samples - current_sample) % frame_samples;
        if distance == 0 {
            distance = frame_samples;
        }
        let sample_cycle = elapsed_samples
            .checked_add(distance)
            .and_then(|samples| samples.checked_mul(u128::from(timing.cycles_per_sample)))
            .and_then(|cycle| i128::try_from(cycle).ok())
            .ok_or(ResidentError::CycleOverflow)?;
        let candidate = self
            .resident
            .epoch_cycle
            .checked_add(sample_cycle)
            .ok_or(ResidentError::CycleOverflow)?;
        Ok(Some(
            u64::try_from(candidate).map_err(|_| ResidentError::CycleOverflow)?,
        ))
    }

    fn next_comparator_cycle_after(
        &self,
        observed_cycle: u64,
    ) -> Result<Option<u64>, ResidentError> {
        let Some(timing) = self.resident.timing else {
            return Ok(None);
        };
        if !timing.display_enabled {
            return Ok(None);
        }
        let mut next: Option<u64> = None;
        for interrupt in self.interrupts {
            let Some(target) = self.comparator_target(interrupt) else {
                continue;
            };
            let cycle = self
                .cycle_for_raster_sample_after(target.target_sample, observed_cycle)?
                .ok_or(ResidentError::CycleOverflow)?;
            next = Some(next.map_or(cycle, |current| current.min(cycle)));
        }
        Ok(next)
    }

    fn next_active_field_cycle_after(
        &self,
        observed_cycle: u64,
    ) -> Result<Option<u64>, ResidentError> {
        let Some(timing) = self.resident.timing else {
            return Ok(None);
        };
        if !timing.display_enabled {
            return Ok(None);
        }
        let mut next: Option<u64> = None;
        for (_, halfline) in Self::active_field_targets(timing).into_iter().flatten() {
            let cycle = self
                .cycle_for_halfline_after(halfline, observed_cycle)?
                .ok_or(ResidentError::CycleOverflow)?;
            next = Some(next.map_or(cycle, |current| current.min(cycle)));
        }
        Ok(next)
    }

    fn next_timing_boundary_cycle_after(
        &self,
        observed_cycle: u64,
    ) -> Result<Option<u64>, ResidentError> {
        let Some(timing) = self.resident.timing else {
            return Ok(None);
        };
        if !timing.display_enabled {
            return Ok(None);
        }
        let mut next: Option<u64> = None;
        for (_, halfline) in Self::timing_field_targets(timing).into_iter().flatten() {
            let cycle = self
                .cycle_for_halfline_after(halfline, observed_cycle)?
                .ok_or(ResidentError::CycleOverflow)?;
            next = Some(next.map_or(cycle, |current| current.min(cycle)));
        }
        Ok(next)
    }

    /// Rebuilds resident VI timing while preserving the exact beam and sub-sample phase.
    pub fn ensure_resident_schedule(&mut self, observed_cycle: u64) -> Result<(), ResidentError> {
        if !self.resident.schedule_dirty {
            return Ok(());
        }
        self.resident.schedule_dirty = false;
        let previous_timing = self.resident.timing;
        let was_enabled = self.resident.beam_enabled;
        let previous_beam = previous_timing.map_or(
            BeamPosition {
                halfline: self.resident.frozen_beam.halfline,
                vertical_count: 1,
                horizontal_count: 1,
                sample: self.resident.frozen_beam.sample,
            },
            |_| self.beam_position_at_cycle(observed_cycle),
        );
        let previous_sample_cycle = if let Some(timing) = previous_timing.filter(|_| was_enabled) {
            (self.elapsed_cycles_from_epoch(observed_cycle) % u128::from(timing.cycles_per_sample))
                as u64
        } else {
            self.resident.frozen_beam.sample_cycle
        };
        let wants_enabled = self.display_config.enable();
        if wants_enabled && !was_enabled {
            self.resident.active_video_lines = Some(
                self.resident
                    .pending_video_lines
                    .unwrap_or(self.vertical_timing.active_video_lines().value()),
            );
            self.resident.active_top_vertical_timing = Some(
                self.resident
                    .pending_top_vertical_timing
                    .unwrap_or(self.top_vertical_timing),
            );
            self.resident.active_bottom_vertical_timing = Some(
                self.resident
                    .pending_bottom_vertical_timing
                    .unwrap_or(self.bottom_vertical_timing),
            );
            self.resident.pending_video_lines = None;
            self.resident.pending_top_vertical_timing = None;
            self.resident.pending_bottom_vertical_timing = None;
        }

        let Some(decoded) = self.decode_resident_timing()? else {
            self.resident.timing = None;
            self.resident.beam_enabled = false;
            self.resident.frozen_beam = FrozenBeam {
                halfline: previous_beam.halfline,
                sample: previous_beam.sample,
                sample_cycle: previous_sample_cycle,
            };
            self.resident.comparator_signature = [u32::MAX; 4];
            self.resident.deadlines = ResidentDeadlines::default();
            return Ok(());
        };

        let timing_changed =
            previous_timing != Some(decoded) || decoded.display_enabled != was_enabled;
        if timing_changed {
            self.resident.timing = Some(decoded);
            let retained_halfline = previous_beam.halfline % decoded.total_halflines;
            let retained_sample = previous_beam.sample.min(decoded.halfline_width - 1);
            let retained_sample_cycle = previous_sample_cycle.min(decoded.cycles_per_sample - 1);
            let phase = u64::from(retained_sample)
                .checked_mul(decoded.cycles_per_sample)
                .and_then(|cycles| cycles.checked_add(retained_sample_cycle))
                .ok_or(ResidentError::CycleOverflow)?;
            self.resident.epoch_halfline = retained_halfline;
            self.resident.epoch_cycle = i128::from(observed_cycle) - i128::from(phase);
            self.resident.frozen_beam = FrozenBeam {
                halfline: retained_halfline,
                sample: retained_sample,
                sample_cycle: retained_sample_cycle,
            };
            self.resident.beam_enabled = decoded.display_enabled;
            self.resident.comparator_signature = self.comparator_signature();
            self.resident.deadlines.comparator =
                self.next_comparator_cycle_after(observed_cycle)?;
            let active = self.next_active_field_cycle_after(observed_cycle)?;
            self.resident.deadlines.presentation = active;
            self.resident.deadlines.scanout_boundary = active;
            self.resident.deadlines.timing_boundary =
                self.next_timing_boundary_cycle_after(observed_cycle)?;
            self.resident.timing_reschedules = self
                .resident
                .timing_reschedules
                .checked_add(1)
                .ok_or(ResidentError::CounterOverflow)?;
        } else {
            let signature = self.comparator_signature();
            if signature != self.resident.comparator_signature {
                self.resident.comparator_signature = signature;
                self.resident.deadlines.comparator =
                    self.next_comparator_cycle_after(observed_cycle)?;
            }
        }

        let beam = self.beam_position_at_cycle(observed_cycle);
        self.vertical_count = beam.vertical_count;
        self.horizontal_count = beam.horizontal_count;
        Ok(())
    }

    fn next_due_raster_cycle(&self, observed_cycle: u64) -> Option<u64> {
        [
            self.resident.deadlines.comparator,
            self.resident.deadlines.timing_boundary,
            self.resident.deadlines.scanout_boundary,
        ]
        .into_iter()
        .flatten()
        .filter(|cycle| *cycle <= observed_cycle)
        .min()
    }

    fn field_at_halfline(targets: [Option<(Field, u32)>; 2], halfline: u32) -> Option<Field> {
        targets
            .into_iter()
            .flatten()
            .find_map(|(field, target)| (target == halfline).then_some(field))
    }

    fn service_comparator(
        &mut self,
        scheduled_cycle: u64,
        observed_cycle: u64,
    ) -> Result<u8, ResidentError> {
        let timing = self.resident.timing.ok_or(ResidentError::TimingOverflow)?;
        let beam = self.beam_position_at_cycle(scheduled_cycle);
        let lateness = observed_cycle.saturating_sub(scheduled_cycle);
        self.resident.missed_halflines = self
            .resident
            .missed_halflines
            .checked_add(lateness / timing.cycles_per_halfline)
            .ok_or(ResidentError::CounterOverflow)?;
        let mut matches = 0u8;
        for index in 0..self.interrupts.len() {
            let Some(target) = self.comparator_target(self.interrupts[index]) else {
                continue;
            };
            if target.vertical_count != beam.vertical_count
                || target.horizontal_count != beam.horizontal_count
            {
                continue;
            }
            matches |= 1 << index;
            self.resident.comparator_matches[index] = self.resident.comparator_matches[index]
                .checked_add(1)
                .ok_or(ResidentError::CounterOverflow)?;
            if !self.interrupts[index].status() {
                self.resident.status_assertions[index] = self.resident.status_assertions[index]
                    .checked_add(1)
                    .ok_or(ResidentError::CounterOverflow)?;
            }
            self.interrupts[index].set_status(true);
        }
        self.resident.deadlines.comparator = self.next_comparator_cycle_after(scheduled_cycle)?;
        Ok(matches)
    }

    fn latch_timing_boundary(&mut self, field: Field) {
        match field {
            Field::Top => {
                let next_lines = self
                    .resident
                    .pending_video_lines
                    .or(self.resident.active_video_lines)
                    .unwrap_or(self.vertical_timing.active_video_lines().value());
                let next_top = self
                    .resident
                    .pending_top_vertical_timing
                    .or(self.resident.active_top_vertical_timing)
                    .unwrap_or(self.top_vertical_timing);
                let changed = self.resident.active_video_lines != Some(next_lines)
                    || self.resident.active_top_vertical_timing != Some(next_top);
                self.resident.active_video_lines = Some(next_lines);
                self.resident.active_top_vertical_timing = Some(next_top);
                self.resident.pending_video_lines = None;
                self.resident.pending_top_vertical_timing = None;
                self.resident.schedule_dirty |= changed;
            }
            Field::Bottom => {
                let next_bottom = self
                    .resident
                    .pending_bottom_vertical_timing
                    .or(self.resident.active_bottom_vertical_timing)
                    .unwrap_or(self.bottom_vertical_timing);
                let changed = self.resident.active_bottom_vertical_timing != Some(next_bottom);
                self.resident.active_bottom_vertical_timing = Some(next_bottom);
                self.resident.pending_bottom_vertical_timing = None;
                self.resident.schedule_dirty |= changed;
            }
        }
    }

    fn next_latch_serial(&mut self) -> Result<u64, ResidentError> {
        self.resident.scanout_latch_serial = self
            .resident
            .scanout_latch_serial
            .checked_add(1)
            .ok_or(ResidentError::CounterOverflow)?;
        Ok(self.resident.scanout_latch_serial)
    }

    fn make_latch(
        &mut self,
        write: ScanoutWrite,
        field: Field,
        scheduled_cycle: u64,
    ) -> Result<ScanoutLatch, ResidentError> {
        Ok(ScanoutLatch {
            value: write.value,
            write_cycle: write.write_cycle,
            write_serial: write.write_serial,
            field,
            latched_at_cycle: scheduled_cycle,
            latch_serial: self.next_latch_serial()?,
            page_offset_raw: None,
            display_config: None,
            active_lines: None,
            top_vertical_timing: None,
        })
    }

    fn latch_scanout_boundary(
        &mut self,
        field: Field,
        scheduled_cycle: u64,
    ) -> Result<ScanoutSnapshot, ResidentError> {
        match field {
            Field::Top => {
                let top = self
                    .resident
                    .scanout_pending
                    .top_base
                    .unwrap_or(ScanoutWrite {
                        value: self.top_base_left.to_bits(),
                        write_cycle: scheduled_cycle,
                        write_serial: 0,
                    });
                self.resident.scanout_active.top_base =
                    Some(self.make_latch(top, field, scheduled_cycle)?);

                let picture = self
                    .resident
                    .scanout_pending
                    .picture
                    .unwrap_or(ScanoutWrite {
                        value: u32::from(self.xfb_width.to_bits()),
                        write_cycle: scheduled_cycle,
                        write_serial: 0,
                    });
                let mut picture_latch = self.make_latch(picture, field, scheduled_cycle)?;
                picture_latch.display_config = Some(self.display_config);
                picture_latch.active_lines = Some(
                    self.resident
                        .active_video_lines
                        .unwrap_or(self.vertical_timing.active_video_lines().value()),
                );
                picture_latch.top_vertical_timing = Some(
                    self.resident
                        .active_top_vertical_timing
                        .unwrap_or(self.top_vertical_timing),
                );
                self.resident.scanout_active.picture = Some(picture_latch);
            }
            Field::Bottom => {
                let bottom = self
                    .resident
                    .scanout_pending
                    .bottom_base
                    .unwrap_or(ScanoutWrite {
                        value: self.bottom_base_left.to_bits(),
                        write_cycle: scheduled_cycle,
                        write_serial: 0,
                    });
                let mut bottom_latch = self.make_latch(bottom, field, scheduled_cycle)?;
                bottom_latch.page_offset_raw = Some(self.top_base_left.to_bits());
                self.resident.scanout_active.bottom_base = Some(bottom_latch);
            }
        }
        Ok(self.resident.scanout_active)
    }

    /// Drains every comparator/timing/scanout transition due at or before `observed_cycle`.
    /// Globally overdue cycles win first; a tie is comparator, timing promotion, then scanout.
    pub fn service_resident_due_events(
        &mut self,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        self.ensure_resident_schedule(observed_cycle)?;
        let mut summary = ServiceSummary::default();
        while let Some(scheduled_cycle) = self.next_due_raster_cycle(observed_cycle) {
            let timing = self.resident.timing.ok_or(ResidentError::TimingOverflow)?;
            let comparator_due = self.resident.deadlines.comparator == Some(scheduled_cycle);
            let timing_due = self.resident.deadlines.timing_boundary == Some(scheduled_cycle);
            let scanout_due = self.resident.deadlines.scanout_boundary == Some(scheduled_cycle);
            let halfline = self.beam_position_at_cycle(scheduled_cycle).halfline;
            let timing_field = timing_due
                .then(|| Self::field_at_halfline(Self::timing_field_targets(timing), halfline))
                .flatten();
            let scanout_field = scanout_due
                .then(|| Self::field_at_halfline(Self::active_field_targets(timing), halfline))
                .flatten();
            let due_presentation = self.resident.deadlines.presentation;

            if comparator_due {
                summary.comparator_events = summary
                    .comparator_events
                    .checked_add(1)
                    .ok_or(ResidentError::CounterOverflow)?;
                summary.comparator_match_mask |=
                    self.service_comparator(scheduled_cycle, observed_cycle)?;
            }
            if timing_due {
                if let Some(field) = timing_field {
                    self.latch_timing_boundary(field);
                }
                summary.timing_boundaries = summary
                    .timing_boundaries
                    .checked_add(1)
                    .ok_or(ResidentError::CounterOverflow)?;
                self.resident.deadlines.timing_boundary =
                    self.next_timing_boundary_cycle_after(scheduled_cycle)?;
            }
            if scanout_due {
                if let Some(field) = scanout_field {
                    let snapshot = self.latch_scanout_boundary(field, scheduled_cycle)?;
                    self.resident.scanout_boundaries.push(ScanoutBoundary {
                        scheduled_cycle,
                        field,
                        snapshot,
                    });
                }
                summary.scanout_boundaries = summary
                    .scanout_boundaries
                    .checked_add(1)
                    .ok_or(ResidentError::CounterOverflow)?;
                self.resident.deadlines.scanout_boundary =
                    self.next_active_field_cycle_after(scheduled_cycle)?;
            }

            if self.resident.schedule_dirty {
                self.ensure_resident_schedule(scheduled_cycle)?;
            }
            if scanout_due && due_presentation == Some(scheduled_cycle) {
                self.resident.deadlines.presentation = Some(scheduled_cycle);
            }
            summary.last_scheduled_cycle = Some(scheduled_cycle);
        }
        let beam = self.beam_position_at_cycle(observed_cycle);
        self.vertical_count = beam.vertical_count;
        self.horizontal_count = beam.horizontal_count;
        summary.interrupt_level_active = self.interrupt_level_active();
        Ok(summary)
    }

    /// Synchronizes VI before a same-cycle register mutation.
    pub fn synchronize_resident(
        &mut self,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        self.service_resident_due_events(observed_cycle)
    }

    fn record_scanout_write(
        &mut self,
        value: u32,
        observed_cycle: u64,
    ) -> Result<ScanoutWrite, ResidentError> {
        self.resident.scanout_write_serial = self
            .resident
            .scanout_write_serial
            .checked_add(1)
            .ok_or(ResidentError::CounterOverflow)?;
        Ok(ScanoutWrite {
            value,
            write_cycle: observed_cycle,
            write_serial: self.resident.scanout_write_serial,
        })
    }

    pub fn write_vertical_timing_at(
        &mut self,
        value: VerticalTiming,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.synchronize_resident(observed_cycle)?;
        self.vertical_timing = value;
        self.resident.pending_video_lines = Some(value.active_video_lines().value());
        self.resident.schedule_dirty = true;
        self.ensure_resident_schedule(observed_cycle)?;
        Ok(summary)
    }

    pub fn write_display_config_at(
        &mut self,
        mut value: DisplayConfig,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.synchronize_resident(observed_cycle)?;
        let reset = value.reset();
        value.set_reset(false);
        self.display_config = value;
        if reset {
            self.interrupts = [DisplayInterrupt::default(); 4];
            self.resident.timing = None;
            self.resident.beam_enabled = false;
            self.resident.frozen_beam = FrozenBeam::default();
            self.resident.epoch_cycle = i128::from(observed_cycle);
            self.resident.epoch_halfline = 0;
            self.resident.deadlines = ResidentDeadlines::default();
            self.resident.comparator_signature = [u32::MAX; 4];
            self.resident.scanout_active = ScanoutSnapshot::default();
            self.resident.scanout_pending = ScanoutRegisters::default();
            self.resident.scanout_boundaries.clear();
            self.resident.active_video_lines = None;
            self.resident.pending_video_lines = None;
            self.resident.active_top_vertical_timing = None;
            self.resident.pending_top_vertical_timing = None;
            self.resident.active_bottom_vertical_timing = None;
            self.resident.pending_bottom_vertical_timing = None;
        }
        self.resident.schedule_dirty = true;
        self.ensure_resident_schedule(observed_cycle)?;
        Ok(summary)
    }

    pub fn write_horizontal_timing_at(
        &mut self,
        value: HorizontalTiming,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.synchronize_resident(observed_cycle)?;
        self.horizontal_timing = value;
        self.resident.schedule_dirty = true;
        self.ensure_resident_schedule(observed_cycle)?;
        Ok(summary)
    }

    pub fn write_top_vertical_timing_at(
        &mut self,
        value: FieldVerticalTiming,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.synchronize_resident(observed_cycle)?;
        self.top_vertical_timing = value;
        self.resident.pending_top_vertical_timing = Some(value);
        self.resident.schedule_dirty = true;
        self.ensure_resident_schedule(observed_cycle)?;
        Ok(summary)
    }

    pub fn write_bottom_vertical_timing_at(
        &mut self,
        value: FieldVerticalTiming,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.synchronize_resident(observed_cycle)?;
        self.bottom_vertical_timing = value;
        self.resident.pending_bottom_vertical_timing = Some(value);
        self.resident.schedule_dirty = true;
        self.ensure_resident_schedule(observed_cycle)?;
        Ok(summary)
    }

    pub fn write_clock_at(
        &mut self,
        value: ClockMode,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.synchronize_resident(observed_cycle)?;
        self.clock = value;
        self.resident.schedule_dirty = true;
        self.ensure_resident_schedule(observed_cycle)?;
        Ok(summary)
    }

    pub fn write_top_base_at(
        &mut self,
        value: FieldBase,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.synchronize_resident(observed_cycle)?;
        self.top_base_left = value;
        self.resident.scanout_pending.top_base =
            Some(self.record_scanout_write(value.to_bits(), observed_cycle)?);
        Ok(summary)
    }

    pub fn write_bottom_base_at(
        &mut self,
        value: FieldBase,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.synchronize_resident(observed_cycle)?;
        self.bottom_base_left = value;
        self.resident.scanout_pending.bottom_base =
            Some(self.record_scanout_write(value.to_bits(), observed_cycle)?);
        Ok(summary)
    }

    pub fn write_xfb_width_at(
        &mut self,
        value: ExternalFramebufferWidth,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.synchronize_resident(observed_cycle)?;
        self.xfb_width = value;
        self.resident.scanout_pending.picture =
            Some(self.record_scanout_write(u32::from(value.to_bits()), observed_cycle)?);
        Ok(summary)
    }

    pub fn write_interrupt_at<const N: usize>(
        &mut self,
        new: DisplayInterrupt,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        const { assert!(N < 4) };
        let summary = self.synchronize_resident(observed_cycle)?;
        let previous_status = self.interrupts[N].status();
        self.write_interrupt::<N>(new);
        if previous_status && !self.interrupts[N].status() {
            self.resident.interrupt_acknowledgements[N] = self.resident.interrupt_acknowledgements
                [N]
                .checked_add(1)
                .ok_or(ResidentError::CounterOverflow)?;
        }
        self.resident.schedule_dirty = true;
        self.ensure_resident_schedule(observed_cycle)?;
        Ok(summary)
    }

    /// Exact 16-bit DI0..DI3 register write. A low-half write retains the complete high half; a
    /// high-half write can clear sticky status with zero but cannot fabricate it with one.
    pub fn write_interrupt_half_at<const N: usize>(
        &mut self,
        high: bool,
        value: u16,
        observed_cycle: u64,
    ) -> Result<ServiceSummary, ResidentError> {
        const { assert!(N < 4) };
        let summary = self.synchronize_resident(observed_cycle)?;
        let previous = self.interrupts[N].to_bits();
        let raw = if high {
            (u32::from(value) << 16) | (previous & 0xffff)
        } else {
            (previous & 0xffff_0000) | u32::from(value)
        };
        let previous_status = self.interrupts[N].status();
        self.write_interrupt::<N>(DisplayInterrupt::from_bits(raw));
        if previous_status && !self.interrupts[N].status() {
            self.resident.interrupt_acknowledgements[N] = self.resident.interrupt_acknowledgements
                [N]
                .checked_add(1)
                .ok_or(ResidentError::CounterOverflow)?;
        }
        self.resident.schedule_dirty = true;
        self.ensure_resident_schedule(observed_cycle)?;
        Ok(summary)
    }

    #[must_use]
    pub fn interrupt_level_active(&self) -> bool {
        self.interrupts
            .iter()
            .any(|interrupt| interrupt.enable() && interrupt.status())
    }

    /// Publishes VI's exact scalar state into the resident machine's global deadline selector.
    pub fn publish_resident_deadlines(&self, deadlines: &mut MachineEventDeadlines) {
        let enabled = self
            .resident
            .timing
            .is_some_and(|timing| timing.display_enabled);
        deadlines.set_vi_display_enabled(enabled);
        deadlines.set(
            MachineEventKind::ViComparator,
            self.resident.deadlines.comparator,
        );
        deadlines.set(
            MachineEventKind::ViPresentation,
            self.resident.deadlines.presentation,
        );
        deadlines.set(
            MachineEventKind::ViScanoutBoundary,
            self.resident.deadlines.scanout_boundary,
        );
        deadlines.set(
            MachineEventKind::ViTimingBoundary,
            self.resident.deadlines.timing_boundary,
        );
    }

    fn dimensions_for_snapshot(&self, snapshot: ScanoutSnapshot) -> ScanoutDimensions {
        let picture = snapshot.picture;
        ScanoutDimensions::decode(
            picture.map_or(self.xfb_width.to_bits(), |entry| entry.value as u16),
            picture
                .and_then(|entry| entry.display_config)
                .unwrap_or(self.display_config),
            picture
                .and_then(|entry| entry.active_lines)
                .unwrap_or_else(|| {
                    self.resident.timing.map_or(
                        self.vertical_timing.active_video_lines().value(),
                        |timing| timing.active_video_lines,
                    )
                }),
        )
    }

    fn address_for_snapshot(&self, field: Field, snapshot: ScanoutSnapshot) -> Option<Address> {
        match field {
            Field::Top => {
                let raw = snapshot
                    .top_base
                    .map_or(self.top_base_left.to_bits(), |entry| entry.value);
                Some(xfb_address_from_raw(raw, raw))
            }
            Field::Bottom => {
                let bottom = snapshot.bottom_base?;
                Some(xfb_address_from_raw(bottom.value, bottom.page_offset_raw?))
            }
        }
    }

    /// Claims one due presentation as typed synchronous work and advances only VI's presentation
    /// recurrence. Renderer texture resolution, admission/backpressure, and completion receipts
    /// remain adapter responsibilities.
    pub fn take_resident_scanout_work(
        &mut self,
        observed_cycle: u64,
    ) -> Result<Option<ScanoutWork>, ResidentError> {
        self.ensure_resident_schedule(observed_cycle)?;
        let Some(timing) = self.resident.timing.filter(|timing| timing.display_enabled) else {
            return Ok(None);
        };
        let queued = self.resident.scanout_boundaries.front();
        let (scheduled_cycle, field, snapshot, consumes_boundary) = if let Some(boundary) =
            queued.filter(|boundary| boundary.scheduled_cycle <= observed_cycle)
        {
            (
                boundary.scheduled_cycle,
                boundary.field,
                boundary.snapshot,
                true,
            )
        } else {
            let Some(scheduled_cycle) = self
                .resident
                .deadlines
                .presentation
                .filter(|cycle| *cycle <= observed_cycle)
            else {
                return Ok(None);
            };
            let halfline = self.beam_position_at_cycle(scheduled_cycle).halfline;
            let Some(field) = Self::field_at_halfline(Self::active_field_targets(timing), halfline)
            else {
                self.resident.deadlines.presentation =
                    self.next_active_field_cycle_after(scheduled_cycle)?;
                return Ok(None);
            };
            (scheduled_cycle, field, self.resident.scanout_active, false)
        };
        if consumes_boundary {
            self.resident.scanout_boundaries.pop_front();
        }
        let work = ScanoutWork {
            scheduled_cycle,
            observed_cycle,
            cycles_late: observed_cycle.saturating_sub(scheduled_cycle),
            field,
            address: self.address_for_snapshot(field, snapshot),
            dimensions: self.dimensions_for_snapshot(snapshot),
            snapshot,
        };
        self.resident.deadlines.presentation =
            self.next_active_field_cycle_after(scheduled_cycle)?;
        Ok(Some(work))
    }
}

/// Decodes one packed XFB base using TFBL's shared POFF line for either field.
#[must_use]
pub const fn xfb_address_from_raw(value: u32, top_value: u32) -> Address {
    let base = value & 0x00ff_ffff;
    Address(if top_value & 0x1000_0000 != 0 {
        base.wrapping_shl(5)
    } else {
        base
    })
}

impl System {
    /// System-level seam used by the future browser resident loop. PI delivery is refreshed only
    /// after all same-cycle VI comparator/timing/scanout work is complete.
    pub fn service_resident_video_interface(
        &mut self,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<ServiceSummary, ResidentError> {
        let summary = self.video.service_resident_due_events(observed_cycle)?;
        self.video.publish_resident_deadlines(deadlines);
        pi::check_interrupts(self);
        Ok(summary)
    }

    pub fn take_resident_video_scanout(
        &mut self,
        observed_cycle: u64,
        deadlines: &mut MachineEventDeadlines,
    ) -> Result<Option<ScanoutWork>, ResidentError> {
        let work = self.video.take_resident_scanout_work(observed_cycle)?;
        self.video.publish_resident_deadlines(deadlines);
        Ok(work)
    }
}

pub fn update_display_interrupts(sys: &mut System) {
    let video_width = sys.video.video_width();
    let mut raised = false;
    for interrupt in sys.video.interrupts.iter_mut() {
        interrupt.set_status(false);
        if !interrupt.enable() {
            continue;
        }

        if interrupt.horizontal_count().value() > video_width {
            continue;
        }

        sys.video.horizontal_count = sys
            .video
            .horizontal_count
            .max(interrupt.horizontal_count().value());

        if interrupt.vertical_count().value() == sys.video.vertical_count {
            raised = true;
            interrupt.set_status(true);
        }
    }

    if raised {
        pi::check_interrupts(sys);
    }
}

pub fn vertical_count(sys: &mut System) {
    self::update_display_interrupts(sys);

    let start_of_top_field = sys.video.vertical_count == 1;
    let start_of_bottom_field = sys.video.display_config.field_mode() == FieldMode::Double
        && sys.video.vertical_count as u32 == sys.video.lines_per_frame() / 2 + 1;

    if start_of_top_field || start_of_bottom_field {
        self::present(sys);
    }

    sys.video.vertical_count += 1;
    sys.video.horizontal_count = 1;

    if sys.video.vertical_count as u32 > sys.video.lines_per_frame() {
        sys.video.vertical_count = 1;
    }

    if sys
        .video
        .vertical_count
        .is_multiple_of(sys.serial.poll.x_lines().value())
    {
        si::poll_controller(sys, 0);
        si::poll_controller(sys, 1);
        si::poll_controller(sys, 2);
        si::poll_controller(sys, 3);
    }

    let cycles_per_frame = (FREQUENCY as f64 / sys.video.frame_rate()) as u32;
    let cycles_per_line = cycles_per_frame
        .checked_div(sys.video.lines_per_frame())
        .unwrap_or(cycles_per_frame);

    sys.scheduler
        .schedule(cycles_per_line as u64, self::vertical_count);
}

pub fn update(sys: &mut System) {
    if sys.video.vertical_count as u32 > sys.video.lines_per_frame() {
        sys.video.horizontal_count = 1;
        sys.video.vertical_count = 1;
    }

    sys.scheduler.cancel(self::vertical_count);
    if sys.video.display_config.enable() {
        sys.scheduler.schedule_now(self::vertical_count);
    }
}

pub fn present(sys: &mut System) {
    if sys.gpu.xfb_copies.is_empty() {
        return;
    }

    let frame_dimensions = sys.video.frame_dimensions();
    let stride_in_pixels = sys.video.xfb_stride() as u32;
    let base_copy = sys.gpu.xfb_copies.iter().min_by_key(|x| x.addr).unwrap();

    if frame_dimensions.is_degenerate() {
        // TODO: black out VI
    } else {
        sys.modules
            .render
            .exec(render::Action::SetXfbDimensions(frame_dimensions));
    }

    let mut parts = Vec::with_capacity(sys.gpu.xfb_copies.len());
    for (id, copy) in sys.gpu.xfb_copies.iter().enumerate() {
        let delta_pixels = (copy.addr.value() - base_copy.addr.value()) / 2;
        let offset_x = delta_pixels % stride_in_pixels;
        let offset_y = delta_pixels / stride_in_pixels;

        if offset_x >= frame_dimensions.width as u32 || offset_y >= frame_dimensions.height as u32 {
            continue;
        }

        parts.push(render::XfbPart {
            id: id as u32,
            offset_x,
            offset_y,
        });
    }

    sys.modules.render.exec(render::Action::PresentXfb(parts));
    sys.gpu.xfb_copies.clear();
}

#[cfg(test)]
mod resident_tests {
    use super::*;
    use crate::system::scheduler::{MachineEventDeadlines, RuntimeDeadlinePolicy};

    fn compact_interface() -> Interface {
        let mut video = Interface {
            vertical_timing: VerticalTiming::from_bits((1 << 4) | 1),
            display_config: DisplayConfig::from_bits(1),
            horizontal_timing: HorizontalTiming::from_bits(5u64 << 32),
            top_vertical_timing: FieldVerticalTiming::from_bits(1),
            bottom_vertical_timing: FieldVerticalTiming::from_bits(1),
            xfb_width: ExternalFramebufferWidth::from_bits(0x2850),
            top_base_left: FieldBase::from_bits(0x0012_0000),
            bottom_base_left: FieldBase::from_bits(0x0012_0500),
            ..Interface::default()
        };
        video.ensure_resident_schedule(0).unwrap();
        video
    }

    fn tied_boundary_interface() -> Interface {
        let mut video = Interface {
            vertical_timing: VerticalTiming::from_bits(1 << 4),
            display_config: DisplayConfig::from_bits(1),
            horizontal_timing: HorizontalTiming::from_bits(5u64 << 32),
            top_vertical_timing: FieldVerticalTiming::from_bits(0),
            bottom_vertical_timing: FieldVerticalTiming::from_bits(0),
            xfb_width: ExternalFramebufferWidth::from_bits(0x2850),
            top_base_left: FieldBase::from_bits(0x0012_0000),
            bottom_base_left: FieldBase::from_bits(0x0012_0500),
            interrupts: [
                DisplayInterrupt::from_bits((1 << 16) | 1),
                DisplayInterrupt::default(),
                DisplayInterrupt::default(),
                DisplayInterrupt::default(),
            ],
            ..Interface::default()
        };
        video.ensure_resident_schedule(0).unwrap();
        video
    }

    #[test]
    fn shared_poff_decodes_both_fields_in_32_byte_units() {
        assert_eq!(
            xfb_address_from_raw(0x0001_2345, 0x1001_2345),
            Address(0x0024_68a0)
        );
        assert_eq!(
            xfb_address_from_raw(0x0001_2346, 0x1001_2345),
            Address(0x0024_68c0)
        );
        assert_eq!(
            xfb_address_from_raw(0x1001_2346, 0x0001_2345),
            Address(0x0001_2346)
        );

        let mut video = compact_interface();
        video.top_base_left = FieldBase::from_bits(0x1001_2345);
        video.bottom_base_left = FieldBase::from_bits(0x0001_2346);
        assert_eq!(video.top_xfb_address(), Address(0x0024_68a0));
        assert_eq!(video.bottom_xfb_address(), Address(0x0024_68c0));
    }

    #[test]
    fn timing_and_field_targets_match_browser_integer_oracle() {
        let video = compact_interface();
        let timing = video.resident_timing().unwrap();
        assert_eq!(timing.cycles_per_sample, 36);
        assert_eq!(timing.cycles_per_halfline, 180);
        assert_eq!(timing.top_halflines, 6);
        assert_eq!(timing.bottom_halflines, 6);
        assert_eq!(timing.total_halflines, 12);
        assert_eq!(timing.frame_cycles, 2_160);
        assert_eq!(
            Interface::active_field_targets(timing),
            [Some((Field::Top, 4)), Some((Field::Bottom, 10))]
        );
        assert_eq!(video.resident_deadlines().presentation, Some(720));
        assert_eq!(video.resident_deadlines().scanout_boundary, Some(720));
        assert_eq!(video.resident_deadlines().timing_boundary, Some(1_080));

        let dimensions = ScanoutDimensions::decode(0x2850, DisplayConfig::from_bits(0), 240);
        assert_eq!(dimensions.width, 640);
        assert_eq!(dimensions.field_stride_bytes, 2_560);
        assert_eq!(dimensions.height, 480);
        assert_eq!(dimensions.row_repeat, 2);
        assert_eq!(dimensions.policy, ScanoutPolicy::Bob);
        let direct = ScanoutDimensions::decode(0x2828, DisplayConfig::from_bits(4), 240);
        assert_eq!(direct.field_stride_bytes, 1_280);
        assert_eq!(direct.height, 240);
        assert_eq!(direct.policy, ScanoutPolicy::Direct);
    }

    #[test]
    fn exact_beam_and_comparator_use_horizontal_samples() {
        let mut video = compact_interface();
        assert_eq!(
            video.beam_position_at_cycle(0),
            BeamPosition {
                halfline: 0,
                vertical_count: 1,
                horizontal_count: 1,
                sample: 0,
            }
        );
        assert_eq!(video.beam_position_at_cycle(35).horizontal_count, 1);
        assert_eq!(video.beam_position_at_cycle(36).horizontal_count, 2);
        assert_eq!(video.beam_position_at_cycle(179).horizontal_count, 5);
        assert_eq!(
            video.beam_position_at_cycle(180),
            BeamPosition {
                halfline: 1,
                vertical_count: 1,
                horizontal_count: 6,
                sample: 0,
            }
        );
        assert_eq!(video.beam_position_at_cycle(360).vertical_count, 2);
        assert_eq!(video.beam_position_at_cycle(2_160).halfline, 0);

        video.interrupts[0] = DisplayInterrupt::from_bits((2 << 16) | 3);
        video.resident.schedule_dirty = true;
        video.ensure_resident_schedule(0).unwrap();
        assert_eq!(
            video.comparator_target(video.interrupts[0]),
            Some(ComparatorTarget {
                horizontal_count: 3,
                vertical_count: 2,
                target_sample: 12,
                halfline: 2,
                sample: 2,
            })
        );
        assert_eq!(
            video.comparator_target(DisplayInterrupt::from_bits((2 << 16) | 3 | 0x0400)),
            video.comparator_target(video.interrupts[0]),
            "reserved coordinate bit 10 must not alter the target"
        );
        assert_eq!(
            video.comparator_target(DisplayInterrupt::from_bits((2 << 16) | 11)),
            None,
            "HCT beyond both five-sample halflines is invalid"
        );
        assert_eq!(video.resident_deadlines().comparator, Some(432));
        video.service_resident_due_events(432).unwrap();
        assert_eq!(video.resident_deadlines().comparator, Some(2_592));
    }

    #[test]
    fn comparator_status_is_sticky_clear_by_zero_and_enable_qualified() {
        let mut video = compact_interface();
        video.interrupts[0] = DisplayInterrupt::from_bits((2 << 16) | 3);
        video.resident.schedule_dirty = true;
        video.ensure_resident_schedule(0).unwrap();
        let summary = video.service_resident_due_events(432).unwrap();
        assert_eq!(summary.comparator_match_mask, 1);
        assert!(video.interrupts[0].status());
        assert!(!video.interrupt_level_active());

        video
            .write_interrupt_half_at::<0>(true, 0x9002, 433)
            .unwrap();
        assert_eq!(video.interrupts[0].to_bits(), 0x9002_0003);
        video.write_interrupt_half_at::<0>(false, 4, 434).unwrap();
        assert_eq!(video.interrupts[0].to_bits(), 0x9002_0004);
        assert!(video.interrupts[0].status());
        assert!(video.interrupt_level_active());

        video
            .write_interrupt_half_at::<0>(true, 0x8002, 435)
            .unwrap();
        assert!(video.interrupts[0].status());
        assert!(!video.interrupts[0].enable());

        video
            .write_interrupt_half_at::<0>(true, 0x1003, 436)
            .unwrap();
        assert!(!video.interrupts[0].status());
        assert_eq!(video.resident_interrupt_acknowledgements()[0], 1);
        video
            .write_interrupt_half_at::<0>(true, 0x9003, 437)
            .unwrap();
        assert!(
            !video.interrupts[0].status(),
            "software cannot fabricate status"
        );
        assert_eq!(video.interrupts[0].to_bits(), 0x1003_0004);
    }

    #[test]
    fn same_cycle_scanout_write_lands_after_the_due_boundary() {
        let mut at_boundary = compact_interface();
        at_boundary
            .write_top_base_at(FieldBase::from_bits(0x0014_0000), 720)
            .unwrap();
        assert_eq!(at_boundary.queued_scanout_boundaries(), 1);
        assert_eq!(
            at_boundary
                .active_scanout_snapshot()
                .top_base
                .unwrap()
                .value,
            0x0012_0000
        );
        assert_eq!(
            at_boundary.resident.scanout_pending.top_base.unwrap().value,
            0x0014_0000
        );
        let work = at_boundary
            .take_resident_scanout_work(720)
            .unwrap()
            .unwrap();
        assert_eq!(work.field, Field::Top);
        assert_eq!(work.address, Some(Address(0x0012_0000)));

        let mut before_boundary = compact_interface();
        before_boundary
            .write_top_base_at(FieldBase::from_bits(0x0014_0000), 719)
            .unwrap();
        before_boundary.service_resident_due_events(720).unwrap();
        assert_eq!(
            before_boundary
                .active_scanout_snapshot()
                .top_base
                .unwrap()
                .value,
            0x0014_0000
        );
    }

    #[test]
    fn overdue_drain_is_global_and_ties_compare_promote_then_scanout() {
        let mut video = tied_boundary_interface();
        video
            .write_vertical_timing_at(VerticalTiming::from_bits(2 << 4), 100)
            .unwrap();
        let summary = video.service_resident_due_events(720).unwrap();
        assert_eq!(summary.comparator_events, 1);
        assert_eq!(summary.comparator_match_mask, 1);
        assert_eq!(summary.timing_boundaries, 2);
        assert_eq!(summary.scanout_boundaries, 2);
        assert_eq!(summary.last_scheduled_cycle, Some(720));
        assert!(video.interrupts[0].status());
        assert_eq!(video.queued_scanout_boundaries(), 2);

        let first = video.resident.scanout_boundaries.entries[0].unwrap();
        let second = video.resident.scanout_boundaries.entries[1].unwrap();
        assert_eq!(first.scheduled_cycle, 360);
        assert_eq!(first.field, Field::Bottom);
        assert_eq!(second.scheduled_cycle, 720);
        assert_eq!(second.field, Field::Top);
        assert_eq!(
            second.snapshot.picture.unwrap().active_lines,
            Some(2),
            "scanout tied with the top timing boundary must own promoted ACV"
        );
    }

    #[test]
    fn disable_preserves_sub_sample_phase_and_reset_restarts_clean() {
        let mut video = compact_interface();
        video
            .write_display_config_at(DisplayConfig::from_bits(0), 133)
            .unwrap();
        assert!(!video.resident_beam_enabled());
        let frozen = video.beam_position_at_cycle(10_000);
        assert_eq!(frozen.halfline, 0);
        assert_eq!(frozen.sample, 3);
        assert_eq!(frozen.horizontal_count, 4);
        assert_eq!(video.resident_deadlines(), ResidentDeadlines::default());

        video
            .write_display_config_at(DisplayConfig::from_bits(1), 500)
            .unwrap();
        assert!(video.resident_beam_enabled());
        assert_eq!(video.beam_position_at_cycle(500), frozen);
        assert_eq!(video.beam_position_at_cycle(510).sample, 3);
        assert_eq!(video.beam_position_at_cycle(511).sample, 4);

        video.interrupts[0] = DisplayInterrupt::from_bits(0x9001_0001);
        video
            .write_display_config_at(DisplayConfig::from_bits(3), 600)
            .unwrap();
        assert!(video.resident_beam_enabled());
        assert_eq!(video.beam_position_at_cycle(600).halfline, 0);
        assert_eq!(video.beam_position_at_cycle(600).sample, 0);
        assert_eq!(video.interrupts, [DisplayInterrupt::default(); 4]);
        assert_eq!(video.queued_scanout_boundaries(), 0);
    }

    #[test]
    fn early_clock_slowdown_preserves_phase_with_a_pre_zero_epoch() {
        let mut video = Interface {
            vertical_timing: VerticalTiming::from_bits((1 << 4) | 1),
            display_config: DisplayConfig::from_bits(1),
            horizontal_timing: HorizontalTiming::from_bits(5u64 << 32),
            top_vertical_timing: FieldVerticalTiming::from_bits(1),
            bottom_vertical_timing: FieldVerticalTiming::from_bits(1),
            clock: ClockMode::from_bits(1),
            ..Interface::default()
        };
        video.ensure_resident_schedule(0).unwrap();
        assert_eq!(video.resident_timing().unwrap().cycles_per_sample, 18);
        let before = video.beam_position_at_cycle(20);
        assert_eq!(before.sample, 1);

        video.write_clock_at(ClockMode::from_bits(0), 20).unwrap();
        assert_eq!(video.resident_timing().unwrap().cycles_per_sample, 36);
        assert_eq!(video.resident.epoch_cycle, -18);
        assert_eq!(video.beam_position_at_cycle(20), before);
        assert_eq!(
            video.serial_timing_at_cycle(20),
            Some(si::ViSerialTiming {
                display_enabled: true,
                anchor_cycle: 20,
                anchor_half_line: 0,
                cycles_into_half_line: 38,
                cycles_per_half_line: 180,
                odd_half_lines: 6,
                total_half_lines: 12,
            })
        );
        assert_eq!(video.beam_position_at_cycle(53).sample, 1);
        assert_eq!(
            video
                .serial_timing_at_cycle(53)
                .unwrap()
                .cycles_into_half_line,
            71
        );
        assert_eq!(video.beam_position_at_cycle(54).sample, 2);
        assert!(
            video
                .resident_deadlines()
                .scanout_boundary
                .is_some_and(|cycle| cycle > 20)
        );
    }

    #[test]
    fn vi_deadlines_publish_into_the_machine_selector() {
        let video = compact_interface();
        let mut deadlines = MachineEventDeadlines::default();
        video.publish_resident_deadlines(&mut deadlines);
        assert!(deadlines.vi_display_enabled());
        assert_eq!(
            deadlines.deadline(MachineEventKind::ViPresentation),
            Some(720)
        );
        assert_eq!(
            deadlines.deadline(MachineEventKind::ViTimingBoundary),
            Some(1_080)
        );
        assert_eq!(
            deadlines
                .next_event_after(0, RuntimeDeadlinePolicy::EXACT)
                .unwrap(),
            crate::system::scheduler::MachineEvent {
                kind: MachineEventKind::ViScanoutBoundary,
                cycle: 720,
            }
        );
    }

    #[test]
    fn delayed_scanout_queue_is_fixed_and_keeps_the_latest_eight_fields() {
        let mut video = tied_boundary_interface();
        video.service_resident_due_events(3_600).unwrap();
        assert_eq!(video.queued_scanout_boundaries(), SCANOUT_BOUNDARY_CAPACITY);
        assert_eq!(
            video
                .resident
                .scanout_boundaries
                .front()
                .unwrap()
                .scheduled_cycle,
            1_080,
            "the first two of ten overdue field snapshots are discarded"
        );
    }
}
