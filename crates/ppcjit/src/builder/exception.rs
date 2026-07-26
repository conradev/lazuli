use cranelift_codegen::ir;
use cranelift_codegen::ir::InstBuilder;
use cranelift_codegen::ir::condcodes::IntCC;
use cranelift_codegen::isa::CallConv;
use gekko::disasm::Ins;
use gekko::{Exception, InsExt, ProgramExceptionCause, Reg, SPR};

use super::BlockBuilder;
use crate::builder::{Action, InstructionInfo};

const RFI_INFO: InstructionInfo = InstructionInfo {
    cycles: 2,
    auto_pc: false,
    action: Action::Exit,
};

const EXCEPTION_INFO: InstructionInfo = InstructionInfo {
    cycles: 2,
    auto_pc: false,
    action: Action::ExitNoFlush,
};

const TRAP_INFO: InstructionInfo = InstructionInfo {
    cycles: 2,
    auto_pc: true,
    action: Action::Continue,
};

pub fn raise_exception_sig(ptr_type: ir::Type, call_conv: CallConv) -> ir::Signature {
    ir::Signature {
        params: vec![
            ir::AbiParam::new(ptr_type),       // registers
            ir::AbiParam::new(ir::types::I16), // exception
        ],
        returns: vec![],
        call_conv,
    }
}

impl BlockBuilder<'_> {
    /// # Warning
    /// You should _always_ exit after raising an exception.
    pub fn raise_exception(&mut self, exception: Exception) {
        let exception = self
            .bd
            .ins()
            .iconst(ir::types::I16, exception as u64 as i64);

        self.flush();
        self.publish_hook_cycle_offset();
        self.bd.ins().call(
            self.hooks.raise_exception,
            &[self.consts.regs_ptr, exception],
        );
    }

    /// Raises a Program exception, then records its cause in the SRR1 value produced by the
    /// exception hook.
    pub fn raise_program_exception(&mut self, cause: ProgramExceptionCause) {
        self.raise_exception(Exception::Program);

        let srr1 = self.load_reg(Reg::from(SPR::SRR1));
        let srr1 = self.bd.ins().bor_imm(srr1, cause.srr1_bits() as i64);
        self.store_reg(Reg::from(SPR::SRR1), srr1);
    }

    pub fn illegal(&mut self, _: Ins) -> InstructionInfo {
        self.raise_program_exception(ProgramExceptionCause::IllegalInstruction);
        EXCEPTION_INFO
    }

    fn trap_word_condition(&mut self, lhs: ir::Value, rhs: ir::Value, to: u8) -> ir::Value {
        let mut condition = None;
        for (mask, comparison) in [
            (0x10, IntCC::SignedLessThan),
            (0x08, IntCC::SignedGreaterThan),
            (0x04, IntCC::Equal),
            (0x02, IntCC::UnsignedLessThan),
            (0x01, IntCC::UnsignedGreaterThan),
        ] {
            if to & mask == 0 {
                continue;
            }

            let comparison = self.bd.ins().icmp(comparison, lhs, rhs);
            condition = Some(match condition {
                Some(condition) => self.bd.ins().bor(condition, comparison),
                None => comparison,
            });
        }

        condition.unwrap_or_else(|| self.ir_value(false))
    }

    fn trap_word(&mut self, lhs: ir::Value, rhs: ir::Value, to: u8) -> InstructionInfo {
        let should_trap = self.trap_word_condition(lhs, rhs, to);
        let trap_block = self.bd.create_block();
        let continue_block = self.bd.create_block();
        self.bd.set_cold_block(trap_block);
        self.bd
            .ins()
            .brif(should_trap, trap_block, &[], continue_block, &[]);
        self.bd.seal_block(trap_block);
        self.bd.seal_block(continue_block);

        self.switch_to_bb(trap_block);
        self.raise_program_exception(ProgramExceptionCause::Trap);
        self.exit_with(TRAP_INFO);

        self.switch_to_bb(continue_block);
        self.current_bb = continue_block;

        TRAP_INFO
    }

    pub fn tw(&mut self, ins: Ins) -> InstructionInfo {
        let lhs = self.get(ins.gpr_a());
        let rhs = self.get(ins.gpr_b());
        self.trap_word(lhs, rhs, ins.field_to())
    }

    pub fn twi(&mut self, ins: Ins) -> InstructionInfo {
        let lhs = self.get(ins.gpr_a());
        let rhs = self.ir_value(ins.field_simm() as i32);
        self.trap_word(lhs, rhs, ins.field_to())
    }

    /// Checks whether floating point operations are enabled in MSR and raises an exception if not.
    pub fn check_floats(&mut self) {
        if self.floats_checked || self.frontend.settings.force_fpu {
            return;
        }
        self.floats_checked = true;

        let msr = self.get(Reg::MSR);
        let fp_enabled = self.get_bit(msr, 13);

        let exit_block = self.bd.create_block();
        let continue_block = self.bd.create_block();

        self.bd.set_cold_block(exit_block);

        self.bd
            .ins()
            .brif(fp_enabled, continue_block, &[], exit_block, &[]);

        self.bd.seal_block(exit_block);
        self.bd.seal_block(continue_block);

        self.switch_to_bb(exit_block);
        self.raise_exception(Exception::FloatUnavailable);
        self.exit_with(EXCEPTION_INFO);

        self.switch_to_bb(continue_block);
        self.current_bb = continue_block;
    }

    pub fn sc(&mut self, _: Ins) -> InstructionInfo {
        if self.frontend.settings.nop_syscalls {
            return self.nop(Action::Exit);
        }

        self.raise_exception(Exception::Syscall);
        EXCEPTION_INFO
    }

    pub fn rfi(&mut self, _: Ins) -> InstructionInfo {
        let msr = self.get(Reg::MSR);
        let srr0 = self.get(SPR::SRR0);
        let srr1 = self.get(SPR::SRR1);
        let mask = self.ir_value(Exception::SRR1_TO_MSR_MASK);

        // move only some bits from srr1
        let new_msr = self.bd.ins().bitselect(mask, srr1, msr);

        // clear bit 18
        let new_msr = self.bd.ins().band_imm(new_msr, !(1 << 18));

        // TODO: deal with new_msr exceptions enabled

        // set PC to SRR0
        let new_pc = self.bd.ins().band_imm(srr0, !0b11);
        self.set(Reg::PC, new_pc);
        self.set(Reg::MSR, new_msr);

        self.flush();
        self.call_generic_hook(self.hooks.msr_changed);

        RFI_INFO
    }
}
