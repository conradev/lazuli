//! Rust-owned request/receipt coordinator for the browser renderer boundary.
//!
//! The browser adapter transports an opaque request and its Rust-issued sequence. It never
//! decodes a terminal, chooses a generation, describes a texture layout, or constructs a
//! receipt. This module retains those facts until one exact renderer outcome is encoded.

use std::fmt;

use lazuli_abi::{
    RENDER_RECEIPT_HAS_EFB_VALUE, RENDER_RECEIPT_HAS_PRESENTATION, RENDER_REQUEST_VI_PRESENT,
    RenderPresentationStatus, RenderReceipt, RenderReceiptKind, RenderReceiptStatus,
    ViPresentationMode, ViPresentationRequest,
};
use lzgx_packet::{TerminalKind, inspect_envelope};

use crate::packet::{GxCopyKind, GxEfbPeekState, GxFramePacket};
use crate::{
    GxEfbCopyFormat, GxTextureBaseFormat, GxTextureCopyRamLayout, clipped_copy_extent,
    gx_texture_copy_plan, gx_texture_copy_ram_layout,
};

const MAX_ACTIVE_RESIDENT_RECEIPTS: usize = 8;
const RETIRED_RESIDENT_RECEIPTS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ResidentGxTerminal {
    pub(crate) destination: u32,
    pub(crate) generation: u32,
    pub(crate) output_width: u32,
    pub(crate) output_height: u32,
    pub(crate) stride: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ResidentTextureMaterialization {
    pub(crate) terminal: ResidentGxTerminal,
    pub(crate) copy_format: GxEfbCopyFormat,
    pub(crate) base_format: GxTextureBaseFormat,
    pub(crate) layout: GxTextureCopyRamLayout,
}

impl ResidentTextureMaterialization {
    pub(crate) fn payload_len(self) -> Option<usize> {
        usize::try_from(self.layout.dense_bytes).ok()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResidentRenderWork {
    TextureCopy {
        terminal: ResidentGxTerminal,
        materialization: Option<ResidentTextureMaterialization>,
    },
    XfbCopy {
        terminal: ResidentGxTerminal,
    },
    EfbPeek {
        state: GxEfbPeekState,
    },
    ViPresent {
        request: ViPresentationRequest,
    },
}

impl ResidentRenderWork {
    const fn kind(self) -> RenderReceiptKind {
        match self {
            Self::TextureCopy { .. } => RenderReceiptKind::TextureCopy,
            Self::XfbCopy { .. } => RenderReceiptKind::XfbCopy,
            Self::EfbPeek { .. } => RenderReceiptKind::EfbPeek,
            Self::ViPresent { .. } => RenderReceiptKind::ViPresent,
        }
    }

    const fn generation(self) -> u32 {
        match self {
            Self::TextureCopy { terminal, .. } | Self::XfbCopy { terminal } => terminal.generation,
            Self::EfbPeek { state } => state.request_sequence,
            Self::ViPresent { request } => request.expected_generation,
        }
    }

    pub(crate) const fn accepts_readback_counts(
        self,
        texture_readbacks: usize,
        efb_peek_readbacks: usize,
    ) -> bool {
        match self {
            Self::TextureCopy {
                materialization, ..
            } => texture_readbacks == materialization.is_some() as usize && efb_peek_readbacks == 0,
            Self::XfbCopy { .. } | Self::ViPresent { .. } => {
                texture_readbacks == 0 && efb_peek_readbacks == 0
            }
            Self::EfbPeek { .. } => texture_readbacks == 0 && efb_peek_readbacks == 1,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ResidentRenderOutcome {
    TextureCopy(Vec<u8>),
    XfbCopy,
    EfbPeek(u32),
    ViPresent(ResidentPresentationOutcome),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResidentPresentationOutcome {
    Rejected,
    Staged,
    Presented { serial: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ActiveResidentReceipt {
    ticket_id: u64,
    sequence: u64,
    kind: RenderReceiptKind,
    generation: u32,
}

/// One non-cloneable authorization to finish a parsed renderer request exactly once.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ResidentReceiptTicket {
    identity: ActiveResidentReceipt,
    work: ResidentRenderWork,
}

impl ResidentReceiptTicket {
    pub(crate) const fn work(&self) -> ResidentRenderWork {
        self.work
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ResidentReceiptBridgeError {
    ZeroSequence,
    InvalidRequestFlags,
    InvalidGxEnvelope,
    InvalidGxPacket,
    ZeroGeneration,
    InvalidTextureLayout,
    InvalidViRequest,
    SequenceMismatch,
    DuplicateSequence,
    OutOfOrderSequence,
    ActiveQueueFull,
    TicketIdentityExhausted,
    StaleTicket,
    WrongOutcome,
    InvalidFailureStatus,
    PayloadLengthMismatch,
    ReceiptLengthOverflow,
    ReceiptEncoding,
}

impl fmt::Display for ResidentReceiptBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::ZeroSequence => "resident render sequence is zero",
            Self::InvalidRequestFlags => "resident render request flags are not canonical",
            Self::InvalidGxEnvelope => "resident render request is not a canonical LZGX envelope",
            Self::InvalidGxPacket => "resident render request failed GX semantic validation",
            Self::ZeroGeneration => "resident render terminal generation is zero",
            Self::InvalidTextureLayout => "resident texture-copy layout is not representable",
            Self::InvalidViRequest => "resident VI presentation request is not canonical",
            Self::SequenceMismatch => "resident render payload sequence does not match its request",
            Self::DuplicateSequence => "resident render sequence was already observed",
            Self::OutOfOrderSequence => "resident render sequence regressed",
            Self::ActiveQueueFull => "resident renderer receipt queue is full",
            Self::TicketIdentityExhausted => "resident renderer ticket identity exhausted",
            Self::StaleTicket => "resident renderer completion ticket is stale",
            Self::WrongOutcome => "renderer outcome does not match the retained Rust request",
            Self::InvalidFailureStatus => "renderer failure receipt used a success status",
            Self::PayloadLengthMismatch => {
                "renderer texture payload does not match the retained Rust layout"
            }
            Self::ReceiptLengthOverflow => "renderer receipt length is not representable",
            Self::ReceiptEncoding => "renderer receipt could not be encoded canonically",
        };
        formatter.write_str(message)
    }
}

/// Bounded one-use receipt owner. Sequence admission is monotonic for one renderer lifetime.
#[derive(Debug)]
pub(crate) struct ResidentReceiptBridge {
    active: Vec<ActiveResidentReceipt>,
    retired: [Option<u64>; RETIRED_RESIDENT_RECEIPTS],
    retired_cursor: usize,
    highest_sequence: Option<u64>,
    next_ticket_id: Option<u64>,
}

impl Default for ResidentReceiptBridge {
    fn default() -> Self {
        Self {
            active: Vec::with_capacity(MAX_ACTIVE_RESIDENT_RECEIPTS),
            retired: [None; RETIRED_RESIDENT_RECEIPTS],
            retired_cursor: 0,
            highest_sequence: None,
            next_ticket_id: Some(1),
        }
    }
}

impl ResidentReceiptBridge {
    pub(crate) fn reset(&mut self) {
        self.active.clear();
        self.retired = [None; RETIRED_RESIDENT_RECEIPTS];
        self.retired_cursor = 0;
        self.highest_sequence = None;
        // Do not recycle ticket identities: an asynchronous pre-reset completion must stay stale.
    }

    pub(crate) fn begin(
        &mut self,
        request_flags: u32,
        sequence: u64,
        request_bytes: &[u8],
    ) -> Result<ResidentReceiptTicket, ResidentReceiptBridgeError> {
        let work = parse_request(request_flags, sequence, request_bytes)?;
        if self.active.len() >= MAX_ACTIVE_RESIDENT_RECEIPTS {
            return Err(ResidentReceiptBridgeError::ActiveQueueFull);
        }
        if self.active.iter().any(|active| active.sequence == sequence)
            || self
                .retired
                .iter()
                .flatten()
                .any(|retired| *retired == sequence)
        {
            return Err(ResidentReceiptBridgeError::DuplicateSequence);
        }
        if self
            .highest_sequence
            .is_some_and(|highest| sequence <= highest)
        {
            return Err(ResidentReceiptBridgeError::OutOfOrderSequence);
        }
        let ticket_id = self
            .next_ticket_id
            .ok_or(ResidentReceiptBridgeError::TicketIdentityExhausted)?;
        self.next_ticket_id = ticket_id.checked_add(1);
        let identity = ActiveResidentReceipt {
            ticket_id,
            sequence,
            kind: work.kind(),
            generation: work.generation(),
        };
        self.active.push(identity);
        self.highest_sequence = Some(sequence);
        Ok(ResidentReceiptTicket { identity, work })
    }

    pub(crate) fn complete(
        &mut self,
        ticket: ResidentReceiptTicket,
        outcome: ResidentRenderOutcome,
    ) -> Result<Vec<u8>, ResidentReceiptBridgeError> {
        self.retire_and_encode(ticket, |ticket| encode_completed(ticket, outcome))
    }

    pub(crate) fn fail(
        &mut self,
        ticket: ResidentReceiptTicket,
        status: RenderReceiptStatus,
    ) -> Result<Vec<u8>, ResidentReceiptBridgeError> {
        self.retire_and_encode(ticket, |ticket| encode_failed(ticket, status))
    }

    fn retire_and_encode(
        &mut self,
        ticket: ResidentReceiptTicket,
        encode: impl FnOnce(&ResidentReceiptTicket) -> Result<Vec<u8>, ResidentReceiptBridgeError>,
    ) -> Result<Vec<u8>, ResidentReceiptBridgeError> {
        let Some(index) = self
            .active
            .iter()
            .position(|active| *active == ticket.identity)
        else {
            return Err(ResidentReceiptBridgeError::StaleTicket);
        };
        self.active.remove(index);
        self.retired[self.retired_cursor] = Some(ticket.identity.sequence);
        self.retired_cursor = (self.retired_cursor + 1) % RETIRED_RESIDENT_RECEIPTS;

        match encode(&ticket) {
            Ok(bytes) => Ok(bytes),
            Err(
                ResidentReceiptBridgeError::WrongOutcome
                | ResidentReceiptBridgeError::PayloadLengthMismatch,
            ) => encode_failed(&ticket, RenderReceiptStatus::HostError),
            Err(error) => Err(error),
        }
    }
}

fn parse_request(
    request_flags: u32,
    sequence: u64,
    request_bytes: &[u8],
) -> Result<ResidentRenderWork, ResidentReceiptBridgeError> {
    if sequence == 0 {
        return Err(ResidentReceiptBridgeError::ZeroSequence);
    }
    match request_flags {
        0 => parse_gx_request(request_bytes),
        RENDER_REQUEST_VI_PRESENT => parse_vi_request(sequence, request_bytes),
        _ => Err(ResidentReceiptBridgeError::InvalidRequestFlags),
    }
}

fn parse_gx_request(
    request_bytes: &[u8],
) -> Result<ResidentRenderWork, ResidentReceiptBridgeError> {
    let envelope = inspect_envelope(request_bytes)
        .map_err(|_| ResidentReceiptBridgeError::InvalidGxEnvelope)?;
    let packet = GxFramePacket::parse(request_bytes)
        .map_err(|_| ResidentReceiptBridgeError::InvalidGxPacket)?;
    let header = *packet.header();
    if header.generation == 0 || envelope.terminal.generation == 0 {
        return Err(ResidentReceiptBridgeError::ZeroGeneration);
    }
    let terminal = ResidentGxTerminal {
        destination: header.destination,
        generation: header.generation,
        output_width: header.output_width,
        output_height: header.output_height,
        stride: header.stride,
    };
    match (envelope.terminal.kind, header.copy_kind) {
        (TerminalKind::TextureCopy, GxCopyKind::Texture) => {
            let materialization = if header.texture_copy_layout_v1 {
                let (width, height) = clipped_copy_extent(
                    header.source_x,
                    header.source_y,
                    header.source_width,
                    header.source_height,
                )
                .ok_or(ResidentReceiptBridgeError::InvalidTextureLayout)?;
                let plan = gx_texture_copy_plan(width, height, header.copy_state)
                    .map_err(|_| ResidentReceiptBridgeError::InvalidTextureLayout)?;
                let layout = gx_texture_copy_ram_layout(
                    plan.base_texture_format,
                    plan.output_width,
                    plan.output_height,
                )
                .ok_or(ResidentReceiptBridgeError::InvalidTextureLayout)?;
                Some(ResidentTextureMaterialization {
                    terminal,
                    copy_format: plan.copy_format,
                    base_format: plan.base_texture_format,
                    layout,
                })
            } else {
                None
            };
            Ok(ResidentRenderWork::TextureCopy {
                terminal,
                materialization,
            })
        }
        (TerminalKind::XfbCopy, GxCopyKind::Xfb) => Ok(ResidentRenderWork::XfbCopy { terminal }),
        (TerminalKind::EfbPeek, GxCopyKind::Peek) => Ok(ResidentRenderWork::EfbPeek {
            state: header
                .efb_peek
                .ok_or(ResidentReceiptBridgeError::InvalidGxPacket)?,
        }),
        _ => Err(ResidentReceiptBridgeError::InvalidGxPacket),
    }
}

fn parse_vi_request(
    sequence: u64,
    request_bytes: &[u8],
) -> Result<ResidentRenderWork, ResidentReceiptBridgeError> {
    if request_bytes.len() != ViPresentationRequest::BYTE_LEN {
        return Err(ResidentReceiptBridgeError::InvalidViRequest);
    }
    let request = ViPresentationRequest::decode_le(request_bytes)
        .filter(|request| request.has_canonical_shape())
        .ok_or(ResidentReceiptBridgeError::InvalidViRequest)?;
    if request.sequence() != sequence {
        return Err(ResidentReceiptBridgeError::SequenceMismatch);
    }
    if request.mode() != Ok(ViPresentationMode::Interlaced) && !request.pair_completing() {
        return Err(ResidentReceiptBridgeError::InvalidViRequest);
    }
    Ok(ResidentRenderWork::ViPresent { request })
}

fn encode_completed(
    ticket: &ResidentReceiptTicket,
    outcome: ResidentRenderOutcome,
) -> Result<Vec<u8>, ResidentReceiptBridgeError> {
    let mut receipt = RenderReceipt::new(
        ticket.identity.sequence,
        ticket.identity.kind,
        RenderReceiptStatus::Completed,
        ticket.identity.generation,
    );
    let payload = match (ticket.work, outcome) {
        (
            ResidentRenderWork::TextureCopy {
                materialization, ..
            },
            ResidentRenderOutcome::TextureCopy(payload),
        ) => {
            let expected = materialization
                .and_then(ResidentTextureMaterialization::payload_len)
                .unwrap_or(0);
            if payload.len() != expected {
                return Err(ResidentReceiptBridgeError::PayloadLengthMismatch);
            }
            receipt.payload_len = u32::try_from(payload.len())
                .map_err(|_| ResidentReceiptBridgeError::ReceiptLengthOverflow)?;
            payload
        }
        (ResidentRenderWork::XfbCopy { .. }, ResidentRenderOutcome::XfbCopy) => Vec::new(),
        (ResidentRenderWork::EfbPeek { .. }, ResidentRenderOutcome::EfbPeek(value)) => {
            receipt.flags = RENDER_RECEIPT_HAS_EFB_VALUE;
            receipt.efb_value = value;
            Vec::new()
        }
        (
            ResidentRenderWork::ViPresent { request },
            ResidentRenderOutcome::ViPresent(presentation),
        ) => {
            receipt.flags = RENDER_RECEIPT_HAS_PRESENTATION;
            receipt.presentation_epoch = request.pair_epoch;
            match presentation {
                ResidentPresentationOutcome::Rejected => {
                    receipt.presentation_status_raw = RenderPresentationStatus::Rejected as u32;
                }
                ResidentPresentationOutcome::Staged
                    if request.mode() == Ok(ViPresentationMode::Interlaced)
                        && !request.pair_completing() =>
                {
                    receipt.presentation_width = request.output_width;
                    receipt.presentation_height = request.output_height;
                    receipt.presentation_status_raw = RenderPresentationStatus::Staged as u32;
                }
                ResidentPresentationOutcome::Presented { serial }
                    if request.pair_completing() && serial != 0 =>
                {
                    receipt.presentation_width = request.output_width;
                    receipt.presentation_height = request.output_height;
                    receipt.presentation_serial_lo = serial as u32;
                    receipt.presentation_serial_hi = (serial >> 32) as u32;
                    receipt.presentation_status_raw = RenderPresentationStatus::Presented as u32;
                }
                _ => return Err(ResidentReceiptBridgeError::WrongOutcome),
            }
            Vec::new()
        }
        _ => return Err(ResidentReceiptBridgeError::WrongOutcome),
    };
    encode_receipt(receipt, &payload)
}

fn encode_failed(
    ticket: &ResidentReceiptTicket,
    status: RenderReceiptStatus,
) -> Result<Vec<u8>, ResidentReceiptBridgeError> {
    if status == RenderReceiptStatus::Completed {
        return Err(ResidentReceiptBridgeError::InvalidFailureStatus);
    }
    encode_receipt(
        RenderReceipt::new(
            ticket.identity.sequence,
            ticket.identity.kind,
            status,
            ticket.identity.generation,
        ),
        &[],
    )
}

fn encode_receipt(
    receipt: RenderReceipt,
    payload: &[u8],
) -> Result<Vec<u8>, ResidentReceiptBridgeError> {
    if !receipt.has_canonical_shape()
        || usize::try_from(receipt.payload_len).ok() != Some(payload.len())
    {
        return Err(ResidentReceiptBridgeError::ReceiptEncoding);
    }
    let byte_len = RenderReceipt::BYTE_LEN
        .checked_add(payload.len())
        .ok_or(ResidentReceiptBridgeError::ReceiptLengthOverflow)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(byte_len)
        .map_err(|_| ResidentReceiptBridgeError::ReceiptLengthOverflow)?;
    bytes.resize(RenderReceipt::BYTE_LEN, 0);
    if !receipt.encode_le(&mut bytes) {
        return Err(ResidentReceiptBridgeError::ReceiptEncoding);
    }
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use lazuli_abi::{
        RENDER_RECEIPT_HAS_EFB_VALUE, RENDER_RECEIPT_HAS_PRESENTATION, RENDER_REQUEST_VI_PRESENT,
        RenderPresentationStatus, RenderReceipt, RenderReceiptKind, RenderReceiptStatus,
        ViFieldParity, ViPresentationMode, ViPresentationRequest,
    };
    use lzgx_packet::{CopyState, PacketInput, PacketVersion, TerminalKind, TerminalState, encode};

    use super::{
        ResidentPresentationOutcome, ResidentReceiptBridge, ResidentReceiptBridgeError,
        ResidentRenderOutcome, ResidentRenderWork,
    };

    fn copy_state(copy_command: u32) -> CopyState {
        CopyState {
            z_mode: 0x0001_0203,
            blend_mode: 0x0004_0506,
            pixel_control: 0x0007_0809,
            copy_command,
            clear_rgba: [0x11, 0x22, 0x33, 0x44],
            clear_depth: 0x000a_0b0c,
            copy_scale: 0x000d_0e0f,
            copy_filter: [0x0010_1112, 0x0013_1415],
        }
    }

    fn terminal(kind: TerminalKind) -> TerminalState {
        match kind {
            TerminalKind::TextureCopy => TerminalState {
                kind,
                texture_copy_layout_v1: true,
                source_x: 1,
                source_y: 2,
                source_width: 3,
                source_height: 4,
                output_width: 3,
                output_height: 4,
                destination: 0x0010_0000,
                stride: 32,
                generation: 7,
                clear: true,
                copy: copy_state(0x0000_0800),
            },
            TerminalKind::XfbCopy => TerminalState {
                kind,
                texture_copy_layout_v1: false,
                source_x: 0,
                source_y: 0,
                source_width: 4,
                source_height: 4,
                output_width: 4,
                output_height: 4,
                destination: 0x0011_0000,
                stride: 16,
                generation: 8,
                clear: false,
                copy: copy_state(0x0000_4000),
            },
            TerminalKind::EfbPeek => TerminalState {
                kind,
                texture_copy_layout_v1: false,
                source_x: 320,
                source_y: 240,
                source_width: 1,
                source_height: 1,
                output_width: 0,
                output_height: 0,
                destination: 0,
                stride: 2,
                generation: 9,
                clear: false,
                copy: CopyState::default(),
            },
        }
    }

    fn packet(kind: TerminalKind) -> Vec<u8> {
        encode(&PacketInput {
            version: PacketVersion::V4,
            terminal: terminal(kind),
            draws: &[],
            textures: &[],
        })
        .unwrap()
    }

    fn receipt(bytes: &[u8]) -> RenderReceipt {
        RenderReceipt::decode_le(bytes).unwrap()
    }

    fn vi_request(sequence: u64, pair_completing: bool) -> Vec<u8> {
        let request = ViPresentationRequest::new(
            sequence,
            0x0011_0000,
            8,
            0,
            ViPresentationMode::Interlaced,
            if pair_completing {
                ViFieldParity::Bottom
            } else {
                ViFieldParity::Top
            },
            41,
            640,
            480,
            1280,
            240,
            2,
            pair_completing,
        );
        let mut bytes = vec![0; ViPresentationRequest::BYTE_LEN];
        assert!(request.encode_le(&mut bytes));
        bytes
    }

    #[test]
    fn texture_receipt_uses_only_retained_layout_and_exact_payload() {
        let mut bridge = ResidentReceiptBridge::default();
        let ticket = bridge
            .begin(0, 1, &packet(TerminalKind::TextureCopy))
            .unwrap();
        let ResidentRenderWork::TextureCopy {
            materialization: Some(materialization),
            ..
        } = ticket.work()
        else {
            panic!("expected texture materialization");
        };
        let payload = vec![0x5a; materialization.payload_len().unwrap()];
        let encoded = bridge
            .complete(ticket, ResidentRenderOutcome::TextureCopy(payload.clone()))
            .unwrap();
        let decoded = receipt(&encoded);
        assert_eq!(decoded.sequence(), 1);
        assert_eq!(decoded.kind(), Ok(RenderReceiptKind::TextureCopy));
        assert_eq!(decoded.status(), Ok(RenderReceiptStatus::Completed));
        assert_eq!(decoded.generation, 7);
        assert_eq!(decoded.flags, 0);
        assert_eq!(decoded.payload_len as usize, payload.len());
        assert_eq!(&encoded[RenderReceipt::BYTE_LEN..], payload);
    }

    #[test]
    fn texture_payload_mismatch_fails_closed_as_typed_host_error() {
        let mut bridge = ResidentReceiptBridge::default();
        let ticket = bridge
            .begin(0, 2, &packet(TerminalKind::TextureCopy))
            .unwrap();
        let encoded = bridge
            .complete(ticket, ResidentRenderOutcome::TextureCopy(vec![0; 1]))
            .unwrap();
        let decoded = receipt(&encoded);
        assert_eq!(decoded.status(), Ok(RenderReceiptStatus::HostError));
        assert_eq!(decoded.payload_len, 0);
        assert_eq!(encoded.len(), RenderReceipt::BYTE_LEN);
    }

    #[test]
    fn xfb_and_efb_receipts_have_exact_kind_specific_optionals() {
        let mut bridge = ResidentReceiptBridge::default();
        let xfb = bridge.begin(0, 3, &packet(TerminalKind::XfbCopy)).unwrap();
        let encoded = bridge
            .complete(xfb, ResidentRenderOutcome::XfbCopy)
            .unwrap();
        let decoded = receipt(&encoded);
        assert_eq!(decoded.kind(), Ok(RenderReceiptKind::XfbCopy));
        assert_eq!(decoded.generation, 8);
        assert_eq!(decoded.flags, 0);

        let peek = bridge.begin(0, 4, &packet(TerminalKind::EfbPeek)).unwrap();
        let encoded = bridge
            .complete(peek, ResidentRenderOutcome::EfbPeek(0xdead_beef))
            .unwrap();
        let decoded = receipt(&encoded);
        assert_eq!(decoded.kind(), Ok(RenderReceiptKind::EfbPeek));
        assert_eq!(decoded.generation, 9);
        assert_eq!(decoded.flags, RENDER_RECEIPT_HAS_EFB_VALUE);
        assert_eq!(decoded.efb_value, 0xdead_beef);
    }

    #[test]
    fn vi_staged_presented_and_rejected_receipts_derive_all_semantics_from_request() {
        let mut bridge = ResidentReceiptBridge::default();
        let staged = bridge
            .begin(RENDER_REQUEST_VI_PRESENT, 5, &vi_request(5, false))
            .unwrap();
        let encoded = bridge
            .complete(
                staged,
                ResidentRenderOutcome::ViPresent(ResidentPresentationOutcome::Staged),
            )
            .unwrap();
        let decoded = receipt(&encoded);
        assert_eq!(decoded.kind(), Ok(RenderReceiptKind::ViPresent));
        assert_eq!(decoded.generation, 8);
        assert_eq!(decoded.flags, RENDER_RECEIPT_HAS_PRESENTATION);
        assert_eq!(decoded.presentation_epoch, 41);
        assert_eq!(decoded.presentation_width, 640);
        assert_eq!(decoded.presentation_height, 480);
        assert_eq!(
            decoded.presentation_status(),
            Ok(RenderPresentationStatus::Staged)
        );

        let presented = bridge
            .begin(RENDER_REQUEST_VI_PRESENT, 6, &vi_request(6, true))
            .unwrap();
        let encoded = bridge
            .complete(
                presented,
                ResidentRenderOutcome::ViPresent(ResidentPresentationOutcome::Presented {
                    serial: 0x1_0000_0002,
                }),
            )
            .unwrap();
        let decoded = receipt(&encoded);
        assert_eq!(decoded.presentation_serial(), 0x1_0000_0002);
        assert_eq!(
            decoded.presentation_status(),
            Ok(RenderPresentationStatus::Presented)
        );

        let rejected = bridge
            .begin(RENDER_REQUEST_VI_PRESENT, 7, &vi_request(7, true))
            .unwrap();
        let encoded = bridge
            .complete(
                rejected,
                ResidentRenderOutcome::ViPresent(ResidentPresentationOutcome::Rejected),
            )
            .unwrap();
        let decoded = receipt(&encoded);
        assert_eq!(decoded.presentation_epoch, 41);
        assert_eq!(decoded.presentation_width, 0);
        assert_eq!(decoded.presentation_height, 0);
        assert_eq!(decoded.presentation_serial(), 0);
        assert_eq!(
            decoded.presentation_status(),
            Ok(RenderPresentationStatus::Rejected)
        );
    }

    #[test]
    fn sequence_and_ticket_ownership_are_monotonic_and_one_use() {
        let mut bridge = ResidentReceiptBridge::default();
        let packet = packet(TerminalKind::XfbCopy);
        let ticket = bridge.begin(0, 8, &packet).unwrap();
        assert_eq!(
            bridge.begin(0, 8, &packet),
            Err(ResidentReceiptBridgeError::DuplicateSequence)
        );
        bridge
            .complete(ticket, ResidentRenderOutcome::XfbCopy)
            .unwrap();
        assert_eq!(
            bridge.begin(0, 7, &packet),
            Err(ResidentReceiptBridgeError::OutOfOrderSequence)
        );
    }

    #[test]
    fn malformed_vi_and_mismatched_outcomes_never_author_semantic_receipts() {
        let mut bridge = ResidentReceiptBridge::default();
        assert_eq!(
            bridge.begin(RENDER_REQUEST_VI_PRESENT, 9, &vi_request(10, false)),
            Err(ResidentReceiptBridgeError::SequenceMismatch)
        );
        assert_eq!(
            bridge.begin(RENDER_REQUEST_VI_PRESENT | 2, 9, &vi_request(9, false)),
            Err(ResidentReceiptBridgeError::InvalidRequestFlags)
        );

        let ticket = bridge.begin(0, 9, &packet(TerminalKind::XfbCopy)).unwrap();
        let encoded = bridge
            .complete(ticket, ResidentRenderOutcome::EfbPeek(1))
            .unwrap();
        let decoded = receipt(&encoded);
        assert_eq!(decoded.kind(), Ok(RenderReceiptKind::XfbCopy));
        assert_eq!(decoded.status(), Ok(RenderReceiptStatus::HostError));
        assert_eq!(decoded.flags, 0);
    }

    #[test]
    fn exact_readback_shape_rejects_missing_extra_and_cross_kind_work() {
        let mut bridge = ResidentReceiptBridge::default();
        let texture = bridge
            .begin(0, 10, &packet(TerminalKind::TextureCopy))
            .unwrap();
        assert!(texture.work().accepts_readback_counts(1, 0));
        assert!(!texture.work().accepts_readback_counts(0, 0));
        assert!(!texture.work().accepts_readback_counts(2, 0));
        assert!(!texture.work().accepts_readback_counts(1, 1));

        let peek = bridge.begin(0, 11, &packet(TerminalKind::EfbPeek)).unwrap();
        assert!(peek.work().accepts_readback_counts(0, 1));
        assert!(!peek.work().accepts_readback_counts(0, 0));
        assert!(!peek.work().accepts_readback_counts(1, 0));
    }

    #[test]
    fn wasm_api_contract_is_one_opaque_request_and_one_encoded_byte_result() {
        let source = include_str!("web.rs");
        let api = source
            .split_once("pub fn submit_resident_render(")
            .unwrap()
            .1
            .split_once("pub fn has_presented_xfb")
            .unwrap()
            .0;
        for contract in [
            "source_request: Uint8Array",
            "request_flags: u32",
            "sequence_lo: u32",
            "sequence_hi: u32",
            ") -> Promise",
            "source_request.to_vec()",
            ".begin(request_flags, sequence, &request_bytes)",
            "QueueDrain::new(&queue).await",
            "resident_receipt_js_value(&bridge, ticket, outcome)",
        ] {
            assert!(
                api.contains(contract),
                "missing resident API contract {contract}"
            );
        }
        assert!(!api.contains("Reflect::get"));
        assert!(!api.contains("kind: u32"));
        assert!(!api.contains("generation: u32"));
        assert!(!api.contains("payload_len: u32"));

        let crate_manifest = include_str!("../Cargo.toml");
        assert!(crate_manifest.contains("lazuli-abi = { workspace = true }"));
        assert!(!crate_manifest.contains("browser-machine"));
        for legacy in [
            "pub fn submit_gx_frame(",
            "pub fn drain(&mut self) -> Promise",
            "pub fn drain_efb_peeks(&mut self) -> Promise",
            "pub fn present_xfb(",
        ] {
            assert!(
                source.contains(legacy),
                "legacy renderer oracle removed: {legacy}"
            );
        }
    }
}
