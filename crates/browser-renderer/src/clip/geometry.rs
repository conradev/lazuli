//! Composition of transported GX clip positions and native TEV payloads.
//!
//! This layer remains independent of the live WebGPU submission path.  It
//! qualifies the exact state, carries native attributes through the ordered
//! homogeneous clip walk, projects into local EFB coordinates, and retains
//! the conservative managed-coverage restrictions needed by the current
//! shader.

use std::fmt;

use super::project::{GxExactProjectionError, GxExactProjectionState};
use super::{
    GxClipError, GxRasterClipVertex, gx_clip_mask, gx_post_clip_raster_triangle,
    gx_source_triangle_indices,
};
use crate::packet::{GxDraw, GxExactClipState};
use crate::raster::gx_normalized_raster_channel_u8;
use crate::tev::TEV_VERTEX_FLOATS;
use crate::{
    EFB_HEIGHT, EFB_WIDTH, ExactRequiredPreparationRejectionReason, GX_DEPTH24_MAX, GxRasterScissor,
};

const GX_EXACT_CLIP_PAYLOAD_FLOATS: usize = 4 + (TEV_VERTEX_FLOATS - 12);
const GX_GEN_MODE_MULTISAMPLING: u32 = 1 << 9;
const GX_GEN_MODE_CULL_SHIFT: u32 = 14;
const GX_GEN_MODE_CULL_MASK: u32 = 3;
const GX_GEN_MODE_Z_FREEZE: u32 = 1 << 19;
const GX_XF_CLIP_DISABLE_DEFINED_MASK: u32 = 0b111;
const GX_XF_DISABLE_CLIPPING_DETECTION: u32 = 1 << 0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxExactGeometryError {
    InvalidVertexLayout,
    MissingExactClipInput,
    PositionCountMismatch,
    NonFiniteSourceVertex,
    CullModeStateMismatch,
    UnsupportedMultisampling,
    UnsupportedZFreeze,
    NonCanonicalSourceRaster,
    UnsupportedPostClipW,
    UnsupportedPostClipPosition,
    UnsupportedPostClipDepth,
    Clip(GxClipError),
    Projection(GxExactProjectionError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GxExactPreparationFailure {
    Geometry(GxExactGeometryError),
    InvalidPreparedScissor,
}

impl GxExactPreparationFailure {
    pub(crate) const fn telemetry_reason(self) -> ExactRequiredPreparationRejectionReason {
        use ExactRequiredPreparationRejectionReason as Reason;

        match self {
            Self::Geometry(GxExactGeometryError::InvalidVertexLayout) => {
                Reason::InvalidVertexLayout
            }
            Self::Geometry(GxExactGeometryError::MissingExactClipInput) => {
                Reason::MissingExactClipInput
            }
            Self::Geometry(GxExactGeometryError::PositionCountMismatch) => {
                Reason::PositionCountMismatch
            }
            Self::Geometry(GxExactGeometryError::NonFiniteSourceVertex) => {
                Reason::NonFiniteSourceVertex
            }
            Self::Geometry(GxExactGeometryError::CullModeStateMismatch) => {
                Reason::CullModeStateMismatch
            }
            Self::Geometry(GxExactGeometryError::UnsupportedMultisampling) => {
                Reason::UnsupportedMultisampling
            }
            Self::Geometry(GxExactGeometryError::UnsupportedZFreeze) => Reason::UnsupportedZFreeze,
            Self::Geometry(GxExactGeometryError::NonCanonicalSourceRaster) => {
                Reason::NonCanonicalSourceRaster
            }
            Self::Geometry(GxExactGeometryError::UnsupportedPostClipW) => {
                Reason::UnsupportedPostClipW
            }
            Self::Geometry(GxExactGeometryError::UnsupportedPostClipPosition) => {
                Reason::UnsupportedPostClipPosition
            }
            Self::Geometry(GxExactGeometryError::UnsupportedPostClipDepth) => {
                Reason::UnsupportedPostClipDepth
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::InvalidComponentCount)) => {
                Reason::ClipInvalidComponentCount
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::UnsupportedTopology(5))) => {
                Reason::UnsupportedTopology5
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::UnsupportedTopology(6))) => {
                Reason::UnsupportedTopology6
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::UnsupportedTopology(7))) => {
                Reason::UnsupportedTopology7
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::UnsupportedTopology(_))) => {
                Reason::UnsupportedTopologyOther
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::NoSourceTriangles)) => {
                Reason::ClipNoSourceTriangles
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::InvalidCullMode(_))) => {
                Reason::ClipInvalidCullMode
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::InvalidViewportHeight)) => {
                Reason::ClipInvalidViewportHeight
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::NonFiniteVertex)) => {
                Reason::ClipNonFiniteVertex
            }
            Self::Geometry(GxExactGeometryError::Clip(GxClipError::ArithmeticOverflow)) => {
                Reason::ClipArithmeticOverflow
            }
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidComponentCount,
            )) => Reason::ProjectionInvalidComponentCount,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidBpState,
            )) => Reason::ProjectionInvalidBpState,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidClipDisable(_),
            )) => Reason::ProjectionInvalidClipDisable,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(1),
            )) => Reason::UnsupportedClipDisable1,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(2),
            )) => Reason::UnsupportedClipDisable2,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(3),
            )) => Reason::UnsupportedClipDisable3,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(4),
            )) => Reason::UnsupportedClipDisable4,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(5),
            )) => Reason::UnsupportedClipDisable5,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(6),
            )) => Reason::UnsupportedClipDisable6,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(7),
            )) => Reason::UnsupportedClipDisable7,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::UnsupportedClipDisable(_),
            )) => Reason::UnsupportedClipDisableOther,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidViewport,
            )) => Reason::ProjectionInvalidViewport,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::InvalidScissor,
            )) => Reason::ProjectionInvalidScissor,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::NoVisibleScissor,
            )) => Reason::ProjectionNoVisibleScissor,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::WrappedScissor,
            )) => Reason::ProjectionWrappedScissor,
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::NonFiniteVertex,
            )) => Reason::ProjectionNonFiniteVertex,
            Self::Geometry(GxExactGeometryError::Projection(GxExactProjectionError::ZeroClipW)) => {
                Reason::ProjectionZeroClipW
            }
            Self::Geometry(GxExactGeometryError::Projection(
                GxExactProjectionError::ArithmeticOverflow,
            )) => Reason::ProjectionArithmeticOverflow,
            Self::InvalidPreparedScissor => Reason::InvalidPreparedScissor,
        }
    }
}

impl From<GxExactGeometryError> for GxExactPreparationFailure {
    fn from(error: GxExactGeometryError) -> Self {
        Self::Geometry(error)
    }
}

impl fmt::Display for GxExactGeometryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidVertexLayout => write!(formatter, "invalid GX TEV vertex layout"),
            Self::MissingExactClipInput => write!(formatter, "GX draw has no exact clip input"),
            Self::PositionCountMismatch => {
                write!(formatter, "GX clip positions do not match TEV vertices")
            }
            Self::NonFiniteSourceVertex => write!(formatter, "non-finite GX TEV source vertex"),
            Self::CullModeStateMismatch => {
                write!(
                    formatter,
                    "GX exact state cull mode does not match the draw"
                )
            }
            Self::UnsupportedMultisampling => {
                write!(formatter, "multisampled GX coverage is not yet exact")
            }
            Self::UnsupportedZFreeze => write!(formatter, "GX Z-freeze is not yet exact"),
            Self::NonCanonicalSourceRaster => {
                write!(
                    formatter,
                    "GX source raster endpoint is not canonical u8/255"
                )
            }
            Self::UnsupportedPostClipW => {
                write!(formatter, "GX post-clip W is not strictly positive")
            }
            Self::UnsupportedPostClipPosition => {
                write!(formatter, "GX post-clip position leaves the EFB")
            }
            Self::UnsupportedPostClipDepth => {
                write!(formatter, "GX post-clip depth leaves the 24-bit EFB range")
            }
            Self::Clip(error) => write!(formatter, "{error}"),
            Self::Projection(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for GxExactGeometryError {}

impl From<GxClipError> for GxExactGeometryError {
    fn from(error: GxClipError) -> Self {
        Self::Clip(error)
    }
}

impl From<GxExactProjectionError> for GxExactGeometryError {
    fn from(error: GxExactProjectionError) -> Self {
        Self::Projection(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GxExactRasterGeometry {
    vertices: Vec<f32>,
    source_indices: Vec<[usize; 3]>,
    raster_scissor: GxRasterScissor,
}

impl GxExactRasterGeometry {
    pub(crate) fn vertices(&self) -> &[f32] {
        &self.vertices
    }

    pub(crate) fn into_vertices(self) -> Vec<f32> {
        self.vertices
    }

    pub(crate) fn triangle_count(&self) -> usize {
        self.vertices.len() / (TEV_VERTEX_FLOATS * 3)
    }

    pub(crate) fn source_indices(&self) -> &[[usize; 3]] {
        &self.source_indices
    }

    pub(crate) const fn raster_scissor(&self) -> GxRasterScissor {
        self.raster_scissor
    }

    pub(crate) const fn scissor_rect(&self) -> [u16; 4] {
        self.raster_scissor.rect()
    }
}

pub(crate) fn gx_exact_draw_raster_geometry(
    draw: GxDraw<'_>,
    source_vertices: &[f32],
) -> Result<GxExactRasterGeometry, GxExactGeometryError> {
    let exact = draw
        .exact_clip_input
        .ok_or(GxExactGeometryError::MissingExactClipInput)?;
    let clip_positions = exact.positions().collect::<Vec<_>>();
    gx_exact_raster_geometry(
        draw.record.topology,
        draw.record.cull_mode,
        source_vertices,
        &clip_positions,
        exact.state,
    )
}

fn gx_exact_raster_geometry(
    topology: u8,
    cull_mode: u8,
    source_vertices: &[f32],
    clip_positions: &[[f32; 4]],
    state: GxExactClipState,
) -> Result<GxExactRasterGeometry, GxExactGeometryError> {
    if source_vertices.is_empty() || !source_vertices.len().is_multiple_of(TEV_VERTEX_FLOATS) {
        return Err(GxExactGeometryError::InvalidVertexLayout);
    }
    let vertex_count = source_vertices.len() / TEV_VERTEX_FLOATS;
    if clip_positions.len() != vertex_count {
        return Err(GxExactGeometryError::PositionCountMismatch);
    }
    if source_vertices
        .iter()
        .any(|component| !component.is_finite())
    {
        return Err(GxExactGeometryError::NonFiniteSourceVertex);
    }
    for vertex in source_vertices.chunks_exact(TEV_VERTEX_FLOATS) {
        for value in &vertex[4..12] {
            let byte = gx_normalized_raster_channel_u8(*value);
            let canonical = f32::from(byte) / 255.0;
            if !(*value == 0.0 && canonical == 0.0) && value.to_bits() != canonical.to_bits() {
                return Err(GxExactGeometryError::NonCanonicalSourceRaster);
            }
        }
    }
    if topology > 4 {
        return Err(GxClipError::UnsupportedTopology(topology).into());
    }
    if cull_mode > 3 {
        return Err(GxClipError::InvalidCullMode(cull_mode).into());
    }

    if ((state.bp_gen_mode >> GX_GEN_MODE_CULL_SHIFT) & GX_GEN_MODE_CULL_MASK)
        != u32::from(cull_mode)
    {
        return Err(GxExactGeometryError::CullModeStateMismatch);
    }
    if state.bp_gen_mode & GX_GEN_MODE_MULTISAMPLING != 0 {
        return Err(GxExactGeometryError::UnsupportedMultisampling);
    }
    if state.bp_gen_mode & GX_GEN_MODE_Z_FREEZE != 0 {
        return Err(GxExactGeometryError::UnsupportedZFreeze);
    }
    let mut projection_state = state;
    if gx_clip_disable_is_proven_noop(state.xf_clip_disable, clip_positions) {
        // Qualification remains deliberately fail-closed for raw nonzero
        // state. Clear the field only after this draw has supplied enough
        // geometry evidence to prove that the enabled stages cannot change
        // its observable result.
        projection_state.xf_clip_disable = 0;
    }
    let projection = match GxExactProjectionState::qualify(projection_state) {
        Ok(projection) => projection,
        Err(GxExactProjectionError::NoVisibleScissor) => {
            return Ok(gx_exact_empty_geometry());
        }
        Err(error) => return Err(error.into()),
    };

    let source_triangles = gx_source_triangle_indices(topology, vertex_count);
    if source_triangles.is_empty() {
        return Err(GxClipError::NoSourceTriangles.into());
    }
    let mut vertices = Vec::new();
    let mut output_source_indices = Vec::new();
    for indices in source_triangles {
        let clip_triangle = indices.map(|index| {
            let source =
                &source_vertices[index * TEV_VERTEX_FLOATS..(index + 1) * TEV_VERTEX_FLOATS];
            let mut vertex = [0.0; GX_EXACT_CLIP_PAYLOAD_FLOATS];
            vertex[..4].copy_from_slice(&clip_positions[index]);
            vertex[4..].copy_from_slice(&source[12..]);
            let raster_channels =
                std::array::from_fn(|channel| gx_normalized_raster_channel_u8(source[4 + channel]));
            GxRasterClipVertex::new(vertex, raster_channels)
        });
        for clipped in
            gx_post_clip_raster_triangle(clip_triangle, cull_mode, projection.viewport()[1])?
        {
            let projected = [
                gx_exact_raster_vertex(
                    projection.project(clipped[0].components())?,
                    clipped[0].raster_channels(),
                ),
                gx_exact_raster_vertex(
                    projection.project(clipped[1].components())?,
                    clipped[1].raster_channels(),
                ),
                gx_exact_raster_vertex(
                    projection.project(clipped[2].components())?,
                    clipped[2].raster_channels(),
                ),
            ];
            if !gx_projected_triangle_is_supported(&projected) {
                return Err(gx_projected_triangle_error(&projected));
            }
            for vertex in projected {
                vertices.extend_from_slice(&vertex);
            }
            output_source_indices.push(indices);
        }
    }

    Ok(GxExactRasterGeometry {
        vertices,
        source_indices: output_source_indices,
        raster_scissor: projection.raster_scissor(),
    })
}

fn gx_clip_disable_is_proven_noop(clip_disable: u32, clip_positions: &[[f32; 4]]) -> bool {
    if clip_disable & !GX_XF_CLIP_DISABLE_DEFINED_MASK != 0 {
        return false;
    }
    if clip_disable & GX_XF_DISABLE_CLIPPING_DETECTION == 0 {
        // Bits 1 and 2 only suppress an early rejection and a clipping
        // acceleration. With clipping still enabled (and Z-freeze rejected
        // above), neither can change the final geometry in this exact subset.
        return true;
    }

    // Disabling clipping detection is observationally inert only when every
    // transported endpoint has positive W and is already on or inside every
    // GX clip plane. In that case neither trivial rejection nor the polygon
    // clip walk can alter any primitive, independent of bits 1 and 2.
    clip_positions
        .iter()
        .all(|position| position[3] > 0.0 && matches!(gx_clip_mask(position), Ok(0)))
}

fn gx_exact_empty_geometry() -> GxExactRasterGeometry {
    GxExactRasterGeometry {
        vertices: Vec::new(),
        source_indices: Vec::new(),
        raster_scissor: GxRasterScissor::new(0, 0, 0, 0, 0, 0)
            .expect("canonical empty GX raster scissor"),
    }
}

fn gx_exact_raster_vertex(
    projected: [f32; GX_EXACT_CLIP_PAYLOAD_FLOATS],
    raster_channels: [u8; 8],
) -> [f32; TEV_VERTEX_FLOATS] {
    let mut vertex = [0.0; TEV_VERTEX_FLOATS];
    vertex[..4].copy_from_slice(&projected[..4]);
    for (destination, channel) in vertex[4..12].iter_mut().zip(raster_channels) {
        *destination = f32::from(channel) / 255.0;
    }
    vertex[12..].copy_from_slice(&projected[4..]);
    vertex
}

fn gx_projected_triangle_is_supported(vertices: &[[f32; TEV_VERTEX_FLOATS]; 3]) -> bool {
    vertices.iter().all(|vertex| {
        vertex[3] > 0.0
            && (0.0..=EFB_WIDTH as f32).contains(&vertex[0])
            && (0.0..=EFB_HEIGHT as f32).contains(&vertex[1])
            && (0.0..=GX_DEPTH24_MAX as f32).contains(&vertex[2])
    })
}

fn gx_projected_triangle_error(vertices: &[[f32; TEV_VERTEX_FLOATS]; 3]) -> GxExactGeometryError {
    if vertices.iter().any(|vertex| vertex[3] <= 0.0) {
        return GxExactGeometryError::UnsupportedPostClipW;
    }
    if vertices.iter().any(|vertex| {
        !(0.0..=EFB_WIDTH as f32).contains(&vertex[0])
            || !(0.0..=EFB_HEIGHT as f32).contains(&vertex[1])
    }) {
        return GxExactGeometryError::UnsupportedPostClipPosition;
    }
    GxExactGeometryError::UnsupportedPostClipDepth
}

#[cfg(test)]
mod tests;
