use std::ops::Deref;

use gekko::disasm::{Ins, Opcode, ParsedIns};
use gekko::{Address, GPR, InsExt};

use crate::block::Pattern;

/// A sequence of PowerPC instructions.
#[derive(Debug, Clone, PartialEq, Eq, Default, Hash)]
pub struct Sequence(pub Vec<Ins>);

impl Sequence {
    fn is_simple_idle_loop(&self) -> bool {
        self.len() == 1 && self[0].code == 0x4800_0000
    }

    fn is_generic_volatile_read(&self) -> bool {
        if self.len() < 3 {
            return false;
        }

        let is_load = matches!(
            self[0].op,
            Opcode::Lbz | Opcode::Lha | Opcode::Lhz | Opcode::Lwz
        );
        let is_cmp_imm = matches!(self[1].op, Opcode::Cmpi | Opcode::Cmpli);
        let is_branch_cond = matches!(self[2].op, Opcode::Bc);
        let load_dst_is_cmp_src = self[0].gpr_d() == self[1].gpr_a();
        let is_rel_jmp_to_start = !self[2].field_aa() && self[2].field_bd() == -8;

        is_load && is_cmp_imm && is_branch_cond && load_dst_is_cmp_src && is_rel_jmp_to_start
    }

    fn is_dsp_send_mailbox_status(&self) -> bool {
        if self.len() != 4 {
            return false;
        }

        let i0_is_addis = matches!(self[0].op, Opcode::Addis);
        let i0_imm = self[0].field_uimm();
        let i0_base = self[0].gpr_a();
        let i0_dst = self[0].gpr_d();

        let i0_is_setting_to_cc00 = i0_is_addis && i0_imm == 0xCC00 && i0_base == GPR::R0;

        let i1_is_lhz = matches!(self[1].op, Opcode::Lhz);
        let i1_src = self[1].gpr_a();
        let i1_dst = self[1].gpr_d();
        let i1_offset = self[1].field_uimm();

        let i1_is_loading_from_mailbox = i1_is_lhz && i1_src == i0_dst && i1_offset == 0x5000;

        let i2_is_rlwinm = matches!(self[2].op, Opcode::Rlwinm);
        let i2_src = self[2].gpr_s();
        let i2_dst = self[2].gpr_a();
        let i2_sh = self[2].field_sh();
        let i2_mb = self[2].field_mb();
        let i2_me = self[2].field_me();

        let i2_is_getting_status = i2_is_rlwinm
            && i2_src == i1_dst
            && i2_dst == GPR::R3
            && i2_sh == 17
            && i2_mb == 31
            && i2_me == 31
            && !self[2].field_rc();

        let i3_is_branch_lr = matches!(self[3].op, Opcode::Bclr);
        let i3_is_branch_always = self[3].field_bo() == 20;

        let i3_is_return = i3_is_branch_lr && i3_is_branch_always && !self[3].field_lk();

        i0_is_setting_to_cc00 && i1_is_loading_from_mailbox && i2_is_getting_status && i3_is_return
    }

    pub fn is_call(&self, pc: Address) -> Option<Address> {
        if self.len() != 1 {
            return None;
        }

        let ins = self[0];
        let is_branch = matches!(ins.op, Opcode::B);
        let links = ins.field_lk();

        let is_call = is_branch && links;
        if !is_call {
            return None;
        }

        Some(if ins.field_aa() {
            Address(ins.field_li() as u32)
        } else {
            Address(pc.0.wrapping_add_signed(ins.field_li()))
        })
    }

    pub fn detect_pattern(&self) -> Pattern {
        if self.is_simple_idle_loop() {
            return Pattern::IdleBasic;
        }

        if self.is_call(Address(0)).is_some() {
            return Pattern::Call;
        }

        if self.is_dsp_send_mailbox_status() {
            return Pattern::DspSendMailboxStatus;
        }

        if self.is_generic_volatile_read() {
            return Pattern::IdleVolatileRead;
        }

        Pattern::None
    }
}

impl Deref for Sequence {
    type Target = [Ins];

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::fmt::Display for Sequence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut parsed = ParsedIns::new();
        for ins in &self.0 {
            ins.parse_basic(&mut parsed);
            writeln!(f, "{parsed}")?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use gekko::disasm::{Extensions, Ins};

    use super::*;

    const SDK_MAILBOX_STATUS: [u32; 4] = [0x3c60_cc00, 0xa003_5000, 0x5403_8ffe, 0x4e80_0020];

    fn sequence(words: impl IntoIterator<Item = u32>) -> Sequence {
        Sequence(
            words
                .into_iter()
                .map(|word| Ins::new(word, Extensions::gekko_broadway()))
                .collect(),
        )
    }

    #[test]
    fn detects_exact_sdk_cpu_mailbox_status_helper() {
        assert_eq!(Pattern::DspSendMailboxStatus as u32, 4);
        assert_eq!(
            sequence(SDK_MAILBOX_STATUS).detect_pattern(),
            Pattern::DspSendMailboxStatus
        );
    }

    #[test]
    fn tracks_equivalent_base_and_load_registers() {
        assert_eq!(
            sequence([
                0x3c80_cc00, // lis r4, 0xcc00
                0xa0a4_5000, // lhz r5, 0x5000(r4)
                0x54a3_8ffe, // rlwinm r3, r5, 17, 31, 31
                0x4e80_0020, // blr
            ])
            .detect_pattern(),
            Pattern::DspSendMailboxStatus
        );
    }

    #[test]
    fn rejects_helpers_without_exact_address_dataflow_and_return_semantics() {
        for (index, replacement) in [
            (0, 0x3c64_cc00), // addis uses r4 instead of the zero base
            (0, 0x3c60_cd00), // wrong MMIO page
            (1, 0xa004_5000), // load does not use the constructed base
            (1, 0xa003_5002), // wrong mailbox half
            (2, 0x5483_8ffe), // extract does not use the loaded value
            (2, 0x5404_8ffe), // result is not returned in r3
            (2, 0x5403_87fe), // wrong rotate amount
            (2, 0x5403_8fbe), // wrong mask
            (2, 0x5403_8fff), // unexpected CR0 side effect
            (3, 0x4e00_0020), // conditional/CTR branch through LR
            (3, 0x4e80_0021), // links instead of returning
        ] {
            let mut words = SDK_MAILBOX_STATUS;
            words[index] = replacement;
            assert_eq!(
                sequence(words).detect_pattern(),
                Pattern::None,
                "replacement {replacement:#010x} at word {index} was accepted"
            );
        }
    }
}
