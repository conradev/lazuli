//! BrowserMachine ownership for the optional title-fidelity projector.
//!
//! This layer is deliberately generic at the host boundary. Projector selection comes only from
//! the authenticated Rust disc-boot commit, title memory is read only through observational MPC750
//! translation, and presentation identity comes only from MachineEvidence's authenticated VI
//! chronology.

#![cfg(feature = "game-fidelity-probes")]

use std::cell::RefCell;

use lazuli::Address;
use lazuli::system::System;
use lazuli::system::mem::RAM_LEN;
use lazuli::system::mmu::TranslationEffect;
use lazuli::system::si::{ControllerInputState, ControllerPollSource, ControllerPublication};
use lazuli_abi::{MachineBootStatus, MachineXfbViEvidenceV1, RenderPresentationStatus};

use crate::game_fidelity::{
    ArmObservation, AuthenticatedDiscIdentity, CheckedMem1, FailureCode,
    GAME_FIDELITY_RECORD_BYTES, GameFidelityProbe, GuestReceipt, Mem1ReadFault, P_BASELINE_NEUTRAL,
    P_IDENTITY, P_LIFETIME, P_PRESENTATION, P_PUBLICATION, P_RECEIPT_SEQUENCE,
    PresentationIdentity, PresentationObservation, ProbePhase, PublicationSource, SiPublication,
};
use crate::machine_evidence::AuthenticatedBootState;

#[repr(C, align(8))]
struct AlignedSnapshot([u8; GAME_FIDELITY_RECORD_BYTES]);

impl Default for AlignedSnapshot {
    fn default() -> Self {
        Self([0; GAME_FIDELITY_RECORD_BYTES])
    }
}

/// Feature-only state retained by one BrowserMachine.
#[derive(Default)]
pub(crate) struct GameFidelityIntegration {
    boot_epoch: Option<u64>,
    identity: Option<AuthenticatedDiscIdentity>,
    probe: Option<GameFidelityProbe>,
    publication_sequence: Option<u64>,
    snapshot: AlignedSnapshot,
}

impl GameFidelityIntegration {
    /// Applies only a boot lifecycle already accepted by MachineEvidence.
    pub(crate) fn accept_authenticated_boot(&mut self, state: AuthenticatedBootState) {
        if state.status != MachineBootStatus::Committed {
            self.reset_for_epoch((state.boot_epoch != 0).then_some(state.boot_epoch));
            return;
        }
        let Some(boot_identity) = state.identity else {
            self.fail_closed(FailureCode::UnsupportedIdentity, P_IDENTITY);
            return;
        };
        if state.boot_epoch == 0 {
            self.fail_closed(FailureCode::Range, P_IDENTITY);
            return;
        }
        let identity = AuthenticatedDiscIdentity {
            id: boot_identity.identifier,
            revision: boot_identity.revision,
        };
        if self.boot_epoch == Some(state.boot_epoch) && self.identity == Some(identity) {
            return;
        }
        if self.boot_epoch == Some(state.boot_epoch) && self.identity.is_some() {
            self.fail_closed(FailureCode::UnsupportedIdentity, P_IDENTITY);
            return;
        }

        self.reset_for_epoch(Some(state.boot_epoch));
        self.identity = Some(identity);
        self.probe = GameFidelityProbe::select(identity, state.boot_epoch).ok();
    }

    pub(crate) fn requested_buttons(&self) -> u32 {
        self.requested_controller_state()
            .map_or(0, |state| u32::from(state.buttons))
    }

    /// Returns the exact generic controller state selected by Rust while the transactional
    /// baseline is armed. No host-facing value survives publication or any terminal phase.
    pub(crate) fn requested_controller_state(&self) -> Option<ControllerInputState> {
        self.probe.as_ref().and_then(|probe| {
            (probe.record().phase() == ProbePhase::Baseline)
                .then(|| probe.requested_controller_state())
        })
    }

    pub(crate) fn phase(&self) -> Option<ProbePhase> {
        self.probe.as_ref().map(|probe| probe.record().phase())
    }

    /// Retains an actual typed SI publication. Merely queueing host input never reaches this seam.
    pub(crate) fn accept_authenticated_si_publication(
        &mut self,
        publication: ControllerPublication,
    ) {
        let Some(probe) = self.probe.as_ref() else {
            return;
        };
        if probe.record().phase() != ProbePhase::Baseline
            || u32::from(publication.buttons) != probe.requested_buttons()
        {
            return;
        }
        let Ok(poll_index) = u32::try_from(publication.poll_index) else {
            self.fail_closed(FailureCode::Range, P_PUBLICATION);
            return;
        };
        let source = match publication.source {
            ControllerPollSource::Periodic => PublicationSource::Periodic,
            ControllerPollSource::Direct => PublicationSource::Direct,
        };
        let mut candidate = probe.clone();
        let accepted = candidate.observe_publication(SiPublication {
            scheduled_cycle: publication.scheduled_cycle,
            observed_cycle: publication.observed_cycle,
            poll_index,
            sequence: publication.sequence,
            source,
            buttons: u32::from(publication.buttons),
            state: publication.state,
            mode: publication.mode,
            packet: publication.packet,
        });
        if accepted.is_ok() {
            self.publication_sequence = Some(publication.sequence);
        }
        self.probe = Some(candidate);
    }

    /// Consumes one already-authenticated MachineEvidence VI chronology.
    ///
    /// Unarmed title memory is sampled only here, on Presented completions. Posted probes consume
    /// the same typed event without reading title memory.
    pub(crate) fn accept_authenticated_vi(
        &mut self,
        system: &mut System,
        chronology: MachineXfbViEvidenceV1,
    ) {
        if !chronology.has_canonical_shape() {
            self.fail_closed(FailureCode::Presentation, P_PRESENTATION);
            return;
        }
        let Ok(status) = chronology.presentation_status() else {
            self.fail_closed(FailureCode::Presentation, P_PRESENTATION);
            return;
        };
        if status != RenderPresentationStatus::Presented {
            return;
        }
        let (Ok(mode), Ok(parity)) = (chronology.mode(), chronology.parity()) else {
            self.fail_closed(FailureCode::Presentation, P_PRESENTATION);
            return;
        };
        let observation = PresentationObservation {
            cycle: chronology.render_completion_cycle.get(),
            presentation: PresentationIdentity {
                render_sequence: chronology.render_sequence.get(),
                presentation_serial: chronology.presentation_serial.get(),
                xfb_generation: chronology.xfb_generation,
                selected_row: chronology.selected_row,
                mode,
                parity,
                pair_epoch: chronology.pair_epoch,
                output_width: chronology.output_width,
                output_height: chronology.output_height,
                status,
            },
        };
        match self.phase() {
            Some(ProbePhase::Unarmed) => self.try_arm(system, observation),
            Some(ProbePhase::Posted) => self.accept_later_presentation(observation),
            Some(
                ProbePhase::Baseline
                | ProbePhase::Published
                | ProbePhase::Received
                | ProbePhase::Accepted
                | ProbePhase::Failed,
            )
            | None => {}
        }
    }

    /// Samples only phases whose causal transition requires CPU-authored title state.
    pub(crate) fn sample_after_dispatch(&mut self, system: &mut System, cycle: u64) {
        match self.phase() {
            Some(ProbePhase::Published) => self.try_guest_receipt(system, cycle),
            Some(ProbePhase::Received) => self.try_post(system, cycle),
            Some(
                ProbePhase::Unarmed
                | ProbePhase::Baseline
                | ProbePhase::Posted
                | ProbePhase::Accepted
                | ProbePhase::Failed,
            )
            | None => {}
        }
    }

    /// Invalidates an otherwise complete title record when its owning machine evidence is lost.
    pub(crate) fn fail_machine_lifetime(&mut self) {
        self.fail_closed(FailureCode::Lifetime, P_LIFETIME);
    }

    /// Copies the current reduced record into stable storage only on explicit request.
    pub(crate) fn snapshot(&mut self) -> Option<&[u8; GAME_FIDELITY_RECORD_BYTES]> {
        let probe = self.probe.as_ref()?;
        self.snapshot.0 = probe.record_bytes();
        Some(&self.snapshot.0)
    }

    #[cfg(test)]
    pub(crate) fn probe(&self) -> Option<&GameFidelityProbe> {
        self.probe.as_ref()
    }

    fn reset_for_epoch(&mut self, epoch: Option<u64>) {
        self.boot_epoch = epoch;
        self.identity = None;
        self.probe = None;
        self.publication_sequence = None;
    }

    fn fail_closed(&mut self, code: FailureCode, predicate: u64) {
        if let Some(probe) = self.probe.as_mut() {
            probe.fail_closed(code, predicate);
        }
    }

    fn try_arm(&mut self, system: &mut System, observation: PresentationObservation) {
        let Ok(poll_index) = u32::try_from(system.serial.controller_poll_index()) else {
            self.fail_closed(FailureCode::Range, P_BASELINE_NEUTRAL);
            return;
        };
        let Some(probe) = self.probe.as_ref() else {
            return;
        };
        let applied_sequence = system.serial.controller_applied_sequence();
        let mut candidate = probe.clone();
        let memory = ProbeMem1::new(system);
        let result = candidate.arm(
            &memory,
            ArmObservation {
                cycle: observation.cycle,
                controller_poll_index: poll_index,
                controller_applied_sequence: applied_sequence,
                presentation_cycle: observation.cycle,
                presentation: observation.presentation,
            },
        );
        match result {
            Ok(()) => self.probe = Some(candidate),
            Err(
                FailureCode::MemoryRead
                | FailureCode::Pointer
                | FailureCode::Range
                | FailureCode::NonFinite
                | FailureCode::Predicate
                | FailureCode::Lifetime,
            ) => {}
            Err(_) => self.probe = Some(candidate),
        }
    }

    fn try_guest_receipt(&mut self, system: &mut System, cycle: u64) {
        let Some(expected_sequence) = self.publication_sequence else {
            self.fail_closed(FailureCode::WrongPhase, P_RECEIPT_SEQUENCE);
            return;
        };
        let applied_sequence = system.serial.controller_applied_sequence();
        if applied_sequence != expected_sequence {
            self.fail_closed(FailureCode::Sequence, P_RECEIPT_SEQUENCE);
            return;
        }
        let Ok(poll_index) = u32::try_from(system.serial.controller_poll_index()) else {
            self.fail_closed(FailureCode::Range, P_RECEIPT_SEQUENCE);
            return;
        };
        let Some(probe) = self.probe.as_ref() else {
            return;
        };
        let mut candidate = probe.clone();
        let memory = ProbeMem1::new(system);
        let result = candidate.observe_guest_receipt(
            &memory,
            GuestReceipt {
                cycle,
                poll_index,
                applied_sequence,
            },
        );
        if result.is_ok() || !candidate.is_retryable_transition_failure(ProbePhase::Published) {
            self.probe = Some(candidate);
        }
    }

    fn try_post(&mut self, system: &mut System, cycle: u64) {
        let Some(probe) = self.probe.as_ref() else {
            return;
        };
        match probe.post_observation_ready(cycle) {
            Ok(false) => return,
            Ok(true) => {}
            Err(error) => {
                self.fail_closed(error, crate::game_fidelity::P_POST_ADVANCE);
                return;
            }
        }
        let mut candidate = probe.clone();
        let memory = ProbeMem1::new(system);
        let result = candidate.observe_post(&memory, cycle);
        if result.is_ok() || !candidate.is_retryable_transition_failure(ProbePhase::Received) {
            self.probe = Some(candidate);
        }
    }

    fn accept_later_presentation(&mut self, observation: PresentationObservation) {
        let Some(probe) = self.probe.as_ref() else {
            return;
        };
        match probe.presentation_observation_ready(observation) {
            Ok(false) => return,
            Ok(true) => {}
            Err(error) => {
                self.fail_closed(error, P_PRESENTATION);
                return;
            }
        }
        let mut candidate = probe.clone();
        let _ = candidate.observe_presentation(observation);
        self.probe = Some(candidate);
    }
}

/// Checked, observational view of guest-effective MEM1.
pub(crate) struct ProbeMem1<'a> {
    system: RefCell<&'a mut System>,
}

impl<'a> ProbeMem1<'a> {
    pub(crate) fn new(system: &'a mut System) -> Self {
        Self {
            system: RefCell::new(system),
        }
    }
}

impl CheckedMem1 for ProbeMem1<'_> {
    fn read_exact(&self, effective_address: u32, out: &mut [u8]) -> Result<(), Mem1ReadFault> {
        if out.is_empty() {
            return Err(Mem1ReadFault::CrossesMapping);
        }
        let len = u64::try_from(out.len()).map_err(|_| Mem1ReadFault::CrossesMapping)?;
        let mut system = self
            .system
            .try_borrow_mut()
            .map_err(|_| Mem1ReadFault::Unmapped)?;
        let mapping = system
            .translate_data_range_mmu(
                Address(effective_address),
                len,
                false,
                TranslationEffect::Probe,
            )
            .map_err(|_| Mem1ReadFault::Unmapped)?;
        if mapping.effective != effective_address || mapping.len != len {
            return Err(Mem1ReadFault::CrossesMapping);
        }
        let physical_end = u64::from(mapping.physical)
            .checked_add(len)
            .ok_or(Mem1ReadFault::CrossesMapping)?;
        if physical_end > RAM_LEN as u64 {
            return Err(Mem1ReadFault::Unmapped);
        }
        let start = usize::try_from(mapping.physical).map_err(|_| Mem1ReadFault::CrossesMapping)?;
        let end = usize::try_from(physical_end).map_err(|_| Mem1ReadFault::CrossesMapping)?;
        let source = system
            .mem
            .ram()
            .get(start..end)
            .ok_or(Mem1ReadFault::Unmapped)?;
        out.copy_from_slice(source);
        Ok(())
    }
}
