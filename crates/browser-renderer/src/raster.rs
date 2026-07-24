//! Exact non-antialiased GX coverage semantics.
//!
//! Vertex setup snaps screen coordinates to signed 28.4. Coverage then tests
//! the exact 7/12 EFB sample position on that lattice. The rational sample is
//! intentionally not folded into a Dolphin-style `-9` coordinate bias: that
//! software rasterizer approximation samples at 9/16 and disagrees on edges.
//! Attribute interpolation consumes the same exact 7/12 sample separately.

use std::fmt;

use crate::{EFB_HEIGHT, EFB_WIDTH};

const GX_RASTER_SUBPIXEL_SCALE: i64 = 16;
const GX_RASTER_SAMPLE_DENOMINATOR_28_4: i128 = 3;
const GX_RASTER_SAMPLE_NUMERATOR_28_4: i128 = 28;
const GX_NON_AA_SAMPLE_NUMERATOR: i32 = 7;
const GX_NON_AA_SAMPLE_DENOMINATOR: i32 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxRasterError {
    NonFiniteCoordinate,
    CoordinateOverflow,
    InvalidScissor,
    UnalignedBlockOrigin,
}

impl fmt::Display for GxRasterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFiniteCoordinate => write!(formatter, "non-finite GX raster coordinate"),
            Self::CoordinateOverflow => write!(formatter, "GX 28.4 raster coordinate overflow"),
            Self::InvalidScissor => write!(formatter, "invalid GX raster scissor"),
            Self::UnalignedBlockOrigin => {
                write!(formatter, "GX 2x2 raster block origin is not even-aligned")
            }
        }
    }
}

impl std::error::Error for GxRasterError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct GxRasterCoord28_4(i32);

impl GxRasterCoord28_4 {
    pub(crate) const fn raw(self) -> i32 {
        self.0
    }
}

/// Snaps an EFB-space coordinate to the signed GX 28.4 vertex lattice.
///
/// The reference conversion truncates toward zero and increments only when
/// the remaining fraction is at least one half. Negative fractions therefore
/// retain the reference's asymmetric behavior. No sample-position bias is
/// applied here; exact 7/12 coverage is evaluated separately.
pub(crate) fn gx_non_aa_raster_coord_28_4(
    coordinate: f32,
    scissor_offset: i32,
) -> Result<GxRasterCoord28_4, GxRasterError> {
    if !coordinate.is_finite() {
        return Err(GxRasterError::NonFiniteCoordinate);
    }
    let local = coordinate - scissor_offset as f32;
    let scaled = local * GX_RASTER_SUBPIXEL_SCALE as f32;
    if !scaled.is_finite() {
        return Err(GxRasterError::CoordinateOverflow);
    }
    // 2^31 is exactly representable in f32 whereas i32::MAX is not. Keep the
    // upper comparison exclusive so the subsequent cast has defined range.
    if scaled < i32::MIN as f32 || scaled >= 2_147_483_648.0 {
        return Err(GxRasterError::CoordinateOverflow);
    }
    let truncated = scaled as i32;
    if scaled - truncated as f32 >= 0.5 {
        truncated
            .checked_add(1)
            .map(GxRasterCoord28_4)
            .ok_or(GxRasterError::CoordinateOverflow)
    } else {
        Ok(GxRasterCoord28_4(truncated))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxRasterPoint28_4 {
    x: GxRasterCoord28_4,
    y: GxRasterCoord28_4,
}

impl GxRasterPoint28_4 {
    pub(crate) const fn from_raw(x: i32, y: i32) -> Self {
        Self {
            x: GxRasterCoord28_4(x),
            y: GxRasterCoord28_4(y),
        }
    }

    pub(crate) fn from_efb(
        x: f32,
        y: f32,
        scissor_offset_x: i32,
        scissor_offset_y: i32,
    ) -> Result<Self, GxRasterError> {
        Ok(Self {
            x: gx_non_aa_raster_coord_28_4(x, scissor_offset_x)?,
            y: gx_non_aa_raster_coord_28_4(y, scissor_offset_y)?,
        })
    }

    pub(crate) const fn raw(self) -> [i32; 2] {
        [self.x.raw(), self.y.raw()]
    }
}

/// Exact source-space numerator of the GX non-AA sample, over denominator 12.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxRasterSample12 {
    pub(crate) x_numerator: i32,
    pub(crate) y_numerator: i32,
}

pub(crate) const fn gx_non_aa_raster_sample_12(pixel_x: u16, pixel_y: u16) -> GxRasterSample12 {
    GxRasterSample12 {
        x_numerator: pixel_x as i32 * GX_NON_AA_SAMPLE_DENOMINATOR + GX_NON_AA_SAMPLE_NUMERATOR,
        y_numerator: pixel_y as i32 * GX_NON_AA_SAMPLE_DENOMINATOR + GX_NON_AA_SAMPLE_NUMERATOR,
    }
}

fn gx_non_aa_raster_sample_coordinate(pixel: i32) -> f32 {
    let numerator = i64::from(pixel) * i64::from(GX_NON_AA_SAMPLE_DENOMINATOR)
        + i64::from(GX_NON_AA_SAMPLE_NUMERATOR);
    numerator as f32 / GX_NON_AA_SAMPLE_DENOMINATOR as f32
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxRasterAttributeError {
    NonFinitePosition,
    NonFiniteAttribute,
    DegenerateTriangle,
    PlaneOverflow,
    SampleOverflow,
}

impl fmt::Display for GxRasterAttributeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFinitePosition => write!(formatter, "non-finite GX attribute position"),
            Self::NonFiniteAttribute => write!(formatter, "non-finite GX raster attribute"),
            Self::DegenerateTriangle => write!(formatter, "degenerate GX attribute triangle"),
            Self::PlaneOverflow => write!(formatter, "GX attribute plane arithmetic overflow"),
            Self::SampleOverflow => write!(formatter, "GX attribute sample arithmetic overflow"),
        }
    }
}

impl std::error::Error for GxRasterAttributeError {}

/// Screen-space slopes for one f32 GX raster attribute.
///
/// These are source-EFB derivatives. They intentionally do not consume the
/// snapped 28.4 coverage coordinates: GX coverage and attribute evaluation
/// share the 7/12 sample position, but their setup domains remain distinct.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GxRasterAttributeSlopesF32 {
    dfdx: f32,
    dfdy: f32,
}

impl GxRasterAttributeSlopesF32 {
    pub(crate) const fn dfdx(self) -> f32 {
        self.dfdx
    }

    pub(crate) const fn dfdy(self) -> f32 {
        self.dfdy
    }
}

/// A source-EFB f32 attribute plane evaluated at the exact GX non-AA sample.
///
/// Coefficient setup and final accumulation spell out Dolphin's f32 slope
/// operation order. Sample-coordinate construction deliberately uses Lazuli's
/// exact `(12 * pixel + 7) / 12` authority instead of Dolphin's approximate
/// integer anchor and `0.495` offset. Keeping the intermediates separate
/// prevents an algebraic rewrite or reassociation from moving a truncation
/// boundary.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GxRasterAttributePlaneF32 {
    origin_x: f32,
    origin_y: f32,
    origin_value: f32,
    slopes: GxRasterAttributeSlopesF32,
}

impl GxRasterAttributePlaneF32 {
    pub(crate) fn from_screen_triangle(
        positions: [[f32; 2]; 3],
        attributes: [f32; 3],
    ) -> Result<Self, GxRasterAttributeError> {
        if positions
            .into_iter()
            .flatten()
            .any(|coordinate| !coordinate.is_finite())
        {
            return Err(GxRasterAttributeError::NonFinitePosition);
        }
        if attributes
            .into_iter()
            .any(|attribute| !attribute.is_finite())
        {
            return Err(GxRasterAttributeError::NonFiniteAttribute);
        }

        let [[x0, y0], [x1, y1], [x2, y2]] = positions;
        let [f0, f1, f2] = attributes;

        let dx10 = x1 - x0;
        let dx20 = x2 - x0;
        let dy10 = y1 - y0;
        let dy20 = y2 - y0;
        let delta20 = f2 - f0;
        let delta10 = f1 - f0;
        if [dx10, dx20, dy10, dy20, delta20, delta10]
            .into_iter()
            .any(|value| !value.is_finite())
        {
            return Err(GxRasterAttributeError::PlaneOverflow);
        }

        let a_left = delta20 * dy10;
        let a_right = delta10 * dy20;
        let a = a_left - a_right;
        let b_left = dx20 * delta10;
        let b_right = dx10 * delta20;
        let b = b_left - b_right;
        let c_left = dx20 * dy10;
        let c_right = dx10 * dy20;
        let c = c_left - c_right;
        if c == 0.0 {
            return Err(GxRasterAttributeError::DegenerateTriangle);
        }
        if [a_left, a_right, a, b_left, b_right, b, c_left, c_right, c]
            .into_iter()
            .any(|value| !value.is_finite())
        {
            return Err(GxRasterAttributeError::PlaneOverflow);
        }

        let dfdx = a / c;
        let dfdy = b / c;
        if !dfdx.is_finite() || !dfdy.is_finite() {
            return Err(GxRasterAttributeError::PlaneOverflow);
        }

        Ok(Self {
            origin_x: x0,
            origin_y: y0,
            origin_value: f0,
            slopes: GxRasterAttributeSlopesF32 { dfdx, dfdy },
        })
    }

    pub(crate) const fn slopes(self) -> GxRasterAttributeSlopesF32 {
        self.slopes
    }

    pub(crate) const fn origin_position(self) -> [f32; 2] {
        [self.origin_x, self.origin_y]
    }

    pub(crate) const fn origin_value(self) -> f32 {
        self.origin_value
    }

    pub(crate) fn sample_non_aa(
        self,
        pixel_x: i32,
        pixel_y: i32,
    ) -> Result<f32, GxRasterAttributeError> {
        let sample_x = gx_non_aa_raster_sample_coordinate(pixel_x);
        let sample_y = gx_non_aa_raster_sample_coordinate(pixel_y);
        let dx = sample_x - self.origin_x;
        let dy = sample_y - self.origin_y;
        let x_term = self.slopes.dfdx * dx;
        let y_term = self.slopes.dfdy * dy;
        let x_value = self.origin_value + x_term;
        let value = x_value + y_term;
        if [sample_x, sample_y, dx, dy, x_term, y_term, x_value, value]
            .into_iter()
            .any(|component| !component.is_finite())
        {
            return Err(GxRasterAttributeError::SampleOverflow);
        }
        Ok(value)
    }
}

/// Canonicalizes one screen-linear raster channel like the GX software path:
/// clamp to the unsigned eight-bit range, then truncate toward zero.
pub(crate) fn gx_raster_channel_u8(value: f32) -> u8 {
    if !(value > 0.0) {
        return 0;
    }
    if value >= u8::MAX as f32 {
        return u8::MAX;
    }
    value as u8
}

/// Evaluates four screen-linear channels expressed in GX byte units, then
/// clamps and truncates each result to the EFB's unsigned eight-bit domain.
pub(crate) fn gx_non_aa_raster_color_rgba8(
    planes: [GxRasterAttributePlaneF32; 4],
    pixel_x: i32,
    pixel_y: i32,
) -> Result<[u8; 4], GxRasterAttributeError> {
    Ok([
        gx_raster_channel_u8(planes[0].sample_non_aa(pixel_x, pixel_y)?),
        gx_raster_channel_u8(planes[1].sample_non_aa(pixel_x, pixel_y)?),
        gx_raster_channel_u8(planes[2].sample_non_aa(pixel_x, pixel_y)?),
        gx_raster_channel_u8(planes[3].sample_non_aa(pixel_x, pixel_y)?),
    ])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxRasterScissor {
    left: u16,
    top: u16,
    right: u16,
    bottom: u16,
    x_offset: i32,
    y_offset: i32,
}

impl GxRasterScissor {
    pub(crate) fn new(
        left: u16,
        top: u16,
        right: u16,
        bottom: u16,
        x_offset: i32,
        y_offset: i32,
    ) -> Result<Self, GxRasterError> {
        if left > right
            || top > bottom
            || u32::from(right) > EFB_WIDTH
            || u32::from(bottom) > EFB_HEIGHT
        {
            return Err(GxRasterError::InvalidScissor);
        }
        Ok(Self {
            left,
            top,
            right,
            bottom,
            x_offset,
            y_offset,
        })
    }

    pub(crate) fn full_efb() -> Self {
        Self {
            left: 0,
            top: 0,
            right: EFB_WIDTH as u16,
            bottom: EFB_HEIGHT as u16,
            x_offset: 0,
            y_offset: 0,
        }
    }

    pub(crate) const fn rect(self) -> [u16; 4] {
        [self.left, self.top, self.right, self.bottom]
    }
}

/// Sign of the original, unsnapped screen-space area.
///
/// This is evidence for the caller's cull model, not a cull verdict. GX culls
/// from homogeneous coordinates before clipping and quantization, and viewport
/// orientation can invert the result. Coverage setup preserves this sign even
/// when 28.4 snapping makes the triangle degenerate or reverses its area.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxRasterWinding {
    Negative,
    Collinear,
    Positive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GxRasterEdge28_4 {
    // DX/DY follow Dolphin's edge convention: A - B, not B - A.
    dx: i64,
    dy: i64,
    constant: i128,
    inclusive: bool,
}

impl GxRasterEdge28_4 {
    fn new(a: GxRasterPoint28_4, b: GxRasterPoint28_4) -> Self {
        let ax = i64::from(a.x.0);
        let ay = i64::from(a.y.0);
        let dx = ax - i64::from(b.x.0);
        let dy = ay - i64::from(b.y.0);
        Self {
            dx,
            dy,
            constant: i128::from(dy) * i128::from(ax) - i128::from(dx) * i128::from(ay),
            inclusive: dy < 0 || (dy == 0 && dx > 0),
        }
    }

    fn value_3(self, x: u32, y: u32) -> i128 {
        // A 7/12 EFB sample is 28/3 on the 28.4 lattice. Multiplying
        // the complete edge equation by three keeps the decision exact:
        //
        // E3 = 3*C + DX*(48*y + 28) - DY*(48*x + 28).
        let sample_x = i128::from(x) * 48 + GX_RASTER_SAMPLE_NUMERATOR_28_4;
        let sample_y = i128::from(y) * 48 + GX_RASTER_SAMPLE_NUMERATOR_28_4;
        GX_RASTER_SAMPLE_DENOMINATOR_28_4 * self.constant + i128::from(self.dx) * sample_y
            - i128::from(self.dy) * sample_x
    }

    fn covers_pixel(self, x: u32, y: u32) -> bool {
        let edge_3 = self.value_3(x, y);
        if self.inclusive {
            edge_3 >= 0
        } else {
            edge_3 > 0
        }
    }

    fn mask_2x2(self, block_x: u32, block_y: u32) -> u8 {
        let mut mask = 0;
        for y in 0..2 {
            for x in 0..2 {
                if self.covers_pixel(block_x + x, block_y + y) {
                    mask |= 1 << (y * 2 + x);
                }
            }
        }
        mask
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxRasterBounds {
    pub(crate) left: i32,
    pub(crate) top: i32,
    pub(crate) right: i32,
    pub(crate) bottom: i32,
}

impl GxRasterBounds {
    fn contains(self, x: u32, y: u32) -> bool {
        i64::from(x) >= i64::from(self.left)
            && i64::from(x) < i64::from(self.right)
            && i64::from(y) >= i64::from(self.top)
            && i64::from(y) < i64::from(self.bottom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxRasterMask2x2(u8);

impl GxRasterMask2x2 {
    pub(crate) const fn bits(self) -> u8 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GxRasterTriangle28_4 {
    edges: [GxRasterEdge28_4; 3],
    bounds: GxRasterBounds,
    source_winding: GxRasterWinding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxRasterSetup {
    Degenerate { source_winding: GxRasterWinding },
    Triangle(GxRasterTriangle28_4),
}

impl GxRasterSetup {
    pub(crate) const fn source_winding(self) -> GxRasterWinding {
        match self {
            Self::Degenerate { source_winding } => source_winding,
            Self::Triangle(triangle) => triangle.source_winding,
        }
    }
}

fn gx_raster_area_2(points: [GxRasterPoint28_4; 3]) -> i128 {
    let [a, b, c] = points;
    let ab_x = i64::from(b.x.0) - i64::from(a.x.0);
    let ab_y = i64::from(b.y.0) - i64::from(a.y.0);
    let ac_x = i64::from(c.x.0) - i64::from(a.x.0);
    let ac_y = i64::from(c.y.0) - i64::from(a.y.0);
    i128::from(ab_x) * i128::from(ac_y) - i128::from(ab_y) * i128::from(ac_x)
}

fn gx_raster_ceil_sample_pixel(coordinate: GxRasterCoord28_4) -> i32 {
    // ceil(V/16 - 7/12) = ceil((3*V - 28) / 48).
    let numerator = i64::from(coordinate.0) * 3 - 28;
    let quotient = numerator.div_euclid(48);
    let rounded = quotient + i64::from(numerator.rem_euclid(48) != 0);
    rounded as i32
}

impl GxRasterTriangle28_4 {
    /// Sets up exact coverage from post-cull, already-snapped vertices.
    ///
    /// `source_winding` must describe the original pre-snap primitive. The
    /// point order must be the caller's result after homogeneous culling and
    /// any accepted-backface reorder. Setup never repairs orientation from the
    /// snapped area because quantization can reverse a thin triangle.
    pub(crate) fn setup_post_cull(
        points: [GxRasterPoint28_4; 3],
        source_winding: GxRasterWinding,
        scissor: GxRasterScissor,
    ) -> GxRasterSetup {
        let snapped_area_2 = gx_raster_area_2(points);
        if snapped_area_2 == 0 {
            return GxRasterSetup::Degenerate { source_winding };
        }

        let min_x = points[0].x.min(points[1].x).min(points[2].x);
        let max_x = points[0].x.max(points[1].x).max(points[2].x);
        let min_y = points[0].y.min(points[1].y).min(points[2].y);
        let max_y = points[0].y.max(points[1].y).max(points[2].y);
        let bounds = GxRasterBounds {
            left: gx_raster_ceil_sample_pixel(min_x).max(i32::from(scissor.left)),
            top: gx_raster_ceil_sample_pixel(min_y).max(i32::from(scissor.top)),
            right: gx_raster_ceil_sample_pixel(max_x).min(i32::from(scissor.right)),
            bottom: gx_raster_ceil_sample_pixel(max_y).min(i32::from(scissor.bottom)),
        };
        GxRasterSetup::Triangle(Self {
            edges: [
                GxRasterEdge28_4::new(points[0], points[1]),
                GxRasterEdge28_4::new(points[1], points[2]),
                GxRasterEdge28_4::new(points[2], points[0]),
            ],
            bounds,
            source_winding,
        })
    }

    pub(crate) fn from_post_cull_efb(
        vertices: [[f32; 2]; 3],
        source_winding: GxRasterWinding,
        scissor: GxRasterScissor,
    ) -> Result<GxRasterSetup, GxRasterError> {
        let mut points = [GxRasterPoint28_4::from_raw(0, 0); 3];
        for (point, [x, y]) in points.iter_mut().zip(vertices) {
            *point = GxRasterPoint28_4::from_efb(x, y, scissor.x_offset, scissor.y_offset)?;
        }
        Ok(Self::setup_post_cull(points, source_winding, scissor))
    }

    pub(crate) const fn source_winding(self) -> GxRasterWinding {
        self.source_winding
    }

    pub(crate) const fn bounds(self) -> GxRasterBounds {
        self.bounds
    }

    pub(crate) fn covers_pixel(self, x: u32, y: u32) -> bool {
        self.bounds.contains(x, y) && self.edges.into_iter().all(|edge| edge.covers_pixel(x, y))
    }

    pub(crate) fn coverage_mask_2x2(
        self,
        block_x: u32,
        block_y: u32,
    ) -> Result<GxRasterMask2x2, GxRasterError> {
        if block_x & 1 != 0 || block_y & 1 != 0 {
            return Err(GxRasterError::UnalignedBlockOrigin);
        }
        let edge_mask = self
            .edges
            .into_iter()
            .fold(0x0f, |mask, edge| mask & edge.mask_2x2(block_x, block_y));
        let mut bounds_mask = 0;
        for y in 0..2 {
            for x in 0..2 {
                if self.bounds.contains(block_x + x, block_y + y) {
                    bounds_mask |= 1 << (y * 2 + x);
                }
            }
        }
        Ok(GxRasterMask2x2(edge_mask & bounds_mask))
    }
}

#[cfg(test)]
mod tests;
