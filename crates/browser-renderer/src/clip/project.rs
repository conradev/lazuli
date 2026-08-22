//! Exact viewport projection for qualified, single-rectangle GX scissors.
//!
//! GX scissor coordinates can wrap at 1024-pixel intervals.  This first exact
//! WebGPU layer deliberately accepts only one visible, unwrapped rectangle.
//! Homogeneous positions are then projected into coordinates local to that
//! rectangle's raw BP59 offset with every scalar operation rounded as `f32`.

use std::fmt;

use super::{GX_CLIP_COMPONENTS, gx_add, gx_div, gx_mul, gx_sub};
use crate::packet::GxExactClipState;
use crate::{EFB_HEIGHT, EFB_WIDTH, GxRasterScissor};

const GX_BP_WORD_MAX: u32 = 0x00ff_ffff;
const GX_SCISSOR_COORD_MASK: u32 = 0x7ff;
const GX_SCISSOR_OFFSET_MASK: u32 = 0x1ff;
const GX_SCISSOR_WRAP_PERIOD: i32 = 1024;
const GX_SCISSOR_WRAP_MIN: i32 = -4096;
const GX_SCISSOR_WRAP_MAX: i32 = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxExactProjectionError {
    InvalidComponentCount,
    InvalidBpState,
    InvalidClipDisable(u32),
    UnsupportedClipDisable(u32),
    InvalidViewport,
    InvalidScissor,
    NoVisibleScissor,
    WrappedScissor,
    NonFiniteVertex,
    ZeroClipW,
    ArithmeticOverflow,
}

impl fmt::Display for GxExactProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidComponentCount => {
                write!(formatter, "GX projection vertices require at least XYZW")
            }
            Self::InvalidBpState => write!(formatter, "invalid raw GX BP projection state"),
            Self::InvalidClipDisable(value) => {
                write!(formatter, "invalid GX XF clip-disable value {value}")
            }
            Self::UnsupportedClipDisable(value) => {
                write!(formatter, "unsupported GX XF clip-disable value {value}")
            }
            Self::InvalidViewport => write!(formatter, "invalid GX viewport"),
            Self::InvalidScissor => write!(formatter, "invalid raw GX scissor"),
            Self::NoVisibleScissor => write!(formatter, "GX scissor has no visible EFB rectangle"),
            Self::WrappedScissor => {
                write!(
                    formatter,
                    "GX scissor is not the single unwrapped EFB rectangle"
                )
            }
            Self::NonFiniteVertex => write!(formatter, "non-finite GX projection vertex"),
            Self::ZeroClipW => write!(formatter, "GX projection vertex has zero clip W"),
            Self::ArithmeticOverflow => write!(formatter, "GX projection arithmetic overflow"),
        }
    }
}

impl std::error::Error for GxExactProjectionError {}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct GxExactProjectionState {
    viewport: [f32; 6],
    scissor_offset_x: i32,
    scissor_offset_y: i32,
    raster_scissor: GxRasterScissor,
}

impl GxExactProjectionState {
    pub(crate) fn qualify(state: GxExactClipState) -> Result<Self, GxExactProjectionError> {
        if [
            state.bp_gen_mode,
            state.bp_scissor_top_left,
            state.bp_scissor_bottom_right,
            state.bp_scissor_offset,
        ]
        .into_iter()
        .any(|word| word > GX_BP_WORD_MAX)
        {
            return Err(GxExactProjectionError::InvalidBpState);
        }
        if state.xf_clip_disable > 7 {
            return Err(GxExactProjectionError::InvalidClipDisable(
                state.xf_clip_disable,
            ));
        }
        if state.xf_clip_disable != 0 {
            return Err(GxExactProjectionError::UnsupportedClipDisable(
                state.xf_clip_disable,
            ));
        }

        let viewport = state.viewport();
        if viewport.iter().any(|component| !component.is_finite())
            || viewport[0] == 0.0
            || viewport[1] == 0.0
        {
            return Err(GxExactProjectionError::InvalidViewport);
        }

        let start_x = (state.bp_scissor_top_left >> 12) & GX_SCISSOR_COORD_MASK;
        let start_y = state.bp_scissor_top_left & GX_SCISSOR_COORD_MASK;
        let end_x = (state.bp_scissor_bottom_right >> 12) & GX_SCISSOR_COORD_MASK;
        let end_y = state.bp_scissor_bottom_right & GX_SCISSOR_COORD_MASK;
        let scissor_offset_x = ((state.bp_scissor_offset & GX_SCISSOR_OFFSET_MASK) * 2) as i32;
        let scissor_offset_y =
            (((state.bp_scissor_offset >> 10) & GX_SCISSOR_OFFSET_MASK) * 2) as i32;
        let (left, right) =
            gx_exact_no_wrap_scissor_axis(start_x, end_x, scissor_offset_x, EFB_WIDTH)?;
        let (top, bottom) =
            gx_exact_no_wrap_scissor_axis(start_y, end_y, scissor_offset_y, EFB_HEIGHT)?;
        let raster_scissor = GxRasterScissor::new(left, top, right, bottom, 0, 0)
            .map_err(|_| GxExactProjectionError::InvalidScissor)?;

        Ok(Self {
            viewport,
            scissor_offset_x,
            scissor_offset_y,
            raster_scissor,
        })
    }

    pub(crate) const fn viewport(self) -> [f32; 6] {
        self.viewport
    }

    pub(crate) const fn scissor_offset(self) -> [i32; 2] {
        [self.scissor_offset_x, self.scissor_offset_y]
    }

    pub(crate) const fn raster_scissor(self) -> GxRasterScissor {
        self.raster_scissor
    }

    pub(crate) fn project<const COMPONENTS: usize>(
        self,
        mut vertex: [f32; COMPONENTS],
    ) -> Result<[f32; COMPONENTS], GxExactProjectionError> {
        if COMPONENTS < GX_CLIP_COMPONENTS {
            return Err(GxExactProjectionError::InvalidComponentCount);
        }
        if vertex.iter().any(|component| !component.is_finite()) {
            return Err(GxExactProjectionError::NonFiniteVertex);
        }
        if vertex[3] == 0.0 {
            return Err(GxExactProjectionError::ZeroClipW);
        }

        let inverse_w = gx_div(1.0, vertex[3]);
        let x = gx_sub(
            gx_add(
                gx_mul(gx_mul(vertex[0], inverse_w), self.viewport[0]),
                self.viewport[3],
            ),
            self.scissor_offset_x as f32,
        );
        let y = gx_sub(
            gx_add(
                gx_mul(gx_mul(vertex[1], inverse_w), self.viewport[1]),
                self.viewport[4],
            ),
            self.scissor_offset_y as f32,
        );
        let z = gx_add(
            gx_mul(gx_mul(vertex[2], inverse_w), self.viewport[2]),
            self.viewport[5],
        );
        if [inverse_w, x, y, z]
            .into_iter()
            .any(|component| !component.is_finite())
        {
            return Err(GxExactProjectionError::ArithmeticOverflow);
        }
        vertex[0] = x;
        vertex[1] = y;
        vertex[2] = z;
        Ok(vertex)
    }
}

fn gx_exact_no_wrap_scissor_axis(
    start: u32,
    end: u32,
    base_offset: i32,
    dimension: u32,
) -> Result<(u16, u16), GxExactProjectionError> {
    if end < start || dimension == 0 {
        return Err(GxExactProjectionError::InvalidScissor);
    }
    let start = i32::try_from(start).map_err(|_| GxExactProjectionError::InvalidScissor)?;
    let end = i32::try_from(end).map_err(|_| GxExactProjectionError::InvalidScissor)?;
    let dimension = i32::try_from(dimension).map_err(|_| GxExactProjectionError::InvalidScissor)?;
    let mut visible = None;
    for extra_offset in
        (GX_SCISSOR_WRAP_MIN..=GX_SCISSOR_WRAP_MAX).step_by(GX_SCISSOR_WRAP_PERIOD as usize)
    {
        let offset = base_offset + extra_offset;
        let clipped_start = (start - offset).clamp(0, dimension);
        let clipped_end = (end - offset + 1).clamp(0, dimension);
        if clipped_start >= clipped_end {
            continue;
        }
        if extra_offset != 0 {
            return Err(GxExactProjectionError::WrappedScissor);
        }
        visible = Some((clipped_start, clipped_end));
    }
    let (clipped_start, clipped_end) = visible.ok_or(GxExactProjectionError::NoVisibleScissor)?;
    Ok((
        u16::try_from(clipped_start).map_err(|_| GxExactProjectionError::InvalidScissor)?,
        u16::try_from(clipped_end).map_err(|_| GxExactProjectionError::InvalidScissor)?,
    ))
}

#[cfg(test)]
mod tests;
