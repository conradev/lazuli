use cranelift_codegen::ir;
use cranelift_codegen::ir::InstBuilder;
use cranelift_codegen::ir::condcodes::IntCC;
use gekko::disasm::Ins;
use gekko::{Exception, GPR, InsExt, SPR};

use super::BlockBuilder;
use crate::ExitMode;
use crate::builder::{Action, InstructionInfo, MEMFLAGS, MEMFLAGS_READONLY};

pub trait ReadWriteAble {
    const IR_TYPE: ir::Type;
    fn read_hook(builder: &BlockBuilder) -> ir::FuncRef;
    fn write_hook(builder: &BlockBuilder) -> ir::FuncRef;
}

impl ReadWriteAble for i8 {
    const IR_TYPE: ir::Type = ir::types::I8;

    fn read_hook(builder: &BlockBuilder) -> ir::FuncRef {
        builder.hooks.read_i8
    }

    fn write_hook(builder: &BlockBuilder) -> ir::FuncRef {
        builder.hooks.write_i8
    }
}

impl ReadWriteAble for i16 {
    const IR_TYPE: ir::Type = ir::types::I16;

    fn read_hook(builder: &BlockBuilder) -> ir::FuncRef {
        builder.hooks.read_i16
    }

    fn write_hook(builder: &BlockBuilder) -> ir::FuncRef {
        builder.hooks.write_i16
    }
}

impl ReadWriteAble for i32 {
    const IR_TYPE: ir::Type = ir::types::I32;

    fn read_hook(builder: &BlockBuilder) -> ir::FuncRef {
        builder.hooks.read_i32
    }

    fn write_hook(builder: &BlockBuilder) -> ir::FuncRef {
        builder.hooks.write_i32
    }
}

impl ReadWriteAble for i64 {
    const IR_TYPE: ir::Type = ir::types::I64;

    fn read_hook(builder: &BlockBuilder) -> ir::FuncRef {
        builder.hooks.read_i64
    }

    fn write_hook(builder: &BlockBuilder) -> ir::FuncRef {
        builder.hooks.write_i64
    }
}

/// Helpers
impl BlockBuilder<'_> {
    fn extend_to_pointer_type(&mut self, value: ir::Value) -> ir::Value {
        if self.bd.func.dfg.value_type(value) == self.consts.ptr_type {
            value
        } else {
            self.bd.ins().uextend(self.consts.ptr_type, value)
        }
    }

    fn portable_mem_load<P: ReadWriteAble>(&mut self, addr: ir::Value) -> ir::Value {
        let lut_index = self.bd.ins().ushr_imm(addr, 17);
        let lut_index = self.extend_to_pointer_type(lut_index);
        let lut_offset = self
            .bd
            .ins()
            .imul_imm(lut_index, self.consts.ptr_type.bytes() as i64);
        let lut_ptr = self.bd.ins().iadd(self.consts.fmem_ptr, lut_offset);
        let page = self
            .bd
            .ins()
            .load(self.consts.ptr_type, MEMFLAGS_READONLY, lut_ptr, 0);
        let offset = self.bd.ins().band_imm(addr, (1 << 17) - 1);
        let offset = self.extend_to_pointer_type(offset);
        let ptr = self.bd.ins().iadd(page, offset);
        let value = self.bd.ins().load(P::IR_TYPE, MEMFLAGS, ptr, 0);

        if P::IR_TYPE == ir::types::I8 {
            value
        } else {
            self.bd.ins().bswap(value)
        }
    }

    fn portable_mem_store<P: ReadWriteAble>(&mut self, addr: ir::Value, value: ir::Value) {
        let lut_index = self.bd.ins().ushr_imm(addr, 17);
        let lut_index = self.extend_to_pointer_type(lut_index);
        let lut_offset = self
            .bd
            .ins()
            .imul_imm(lut_index, self.consts.ptr_type.bytes() as i64);
        let lut_ptr = self.bd.ins().iadd(self.consts.fmem_ptr, lut_offset);
        let page = self
            .bd
            .ins()
            .load(self.consts.ptr_type, MEMFLAGS_READONLY, lut_ptr, 0);
        let offset = self.bd.ins().band_imm(addr, ((1u64 << 17) - 1) as i64);
        let offset = self.extend_to_pointer_type(offset);
        let ptr = self.bd.ins().iadd(page, offset);
        let value = if P::IR_TYPE == ir::types::I8 {
            value
        } else {
            self.bd.ins().bswap(value)
        };
        self.bd.ins().store(MEMFLAGS, value, ptr, 0);
    }

    pub fn slow_mem_load<P: ReadWriteAble>(&mut self, addr: ir::Value) -> ir::Value {
        let func = P::read_hook(self);
        let stack_slot_addr =
            self.bd
                .ins()
                .stack_addr(self.consts.ptr_type, self.consts.read_stack_slot, 0);

        self.publish_hook_cycle_offset();
        let inst = self
            .bd
            .ins()
            .call(func, &[self.consts.ctx_ptr, addr, stack_slot_addr]);

        let success = self.bd.inst_results(inst)[0];
        let exit_block = self.bd.create_block();
        let continue_block = self.bd.create_block();

        self.bd.set_cold_block(exit_block);
        self.bd
            .ins()
            .brif(success, continue_block, &[], exit_block, &[]);

        self.bd.seal_block(exit_block);
        self.bd.seal_block(continue_block);

        self.switch_to_bb(exit_block);
        self.set(SPR::DAR, addr);
        self.raise_exception(Exception::DSI);
        self.exit_with(LOAD_INFO);

        self.switch_to_bb(continue_block);
        self.bd
            .ins()
            .stack_load(P::IR_TYPE, self.consts.read_stack_slot, 0)
    }

    pub fn slow_mem_store<P: ReadWriteAble>(&mut self, addr: ir::Value, value: ir::Value) {
        let func = P::write_hook(self);
        self.publish_hook_cycle_offset();
        let inst = self
            .bd
            .ins()
            .call(func, &[self.consts.ctx_ptr, addr, value]);

        let success = self.bd.inst_results(inst)[0];
        let exit_block = self.bd.create_block();
        let continue_block = self.bd.create_block();

        self.bd.set_cold_block(exit_block);
        self.bd
            .ins()
            .brif(success, continue_block, &[], exit_block, &[]);

        self.bd.seal_block(exit_block);

        self.switch_to_bb(exit_block);
        self.set(SPR::DAR, addr);
        self.raise_exception(Exception::DSI);
        self.exit_with(STORE_INFO);

        self.bd.seal_block(continue_block);
        self.switch_to_bb(continue_block);
    }

    pub fn mem_load<P: ReadWriteAble>(&mut self, addr: ir::Value) -> ir::Value {
        if self.frontend.exit_mode == ExitMode::ReturnExecuted {
            return self.portable_mem_load::<P>(addr);
        }

        let lut_index = self.bd.ins().ushr_imm(addr, 17);
        let lut_index = self.extend_to_pointer_type(lut_index);
        let lut_offset = self
            .bd
            .ins()
            .imul_imm(lut_index, self.consts.ptr_type.bytes() as i64);

        let lut_ptr = self.bd.ins().iadd(self.consts.fmem_ptr, lut_offset);
        let ptr = self
            .bd
            .ins()
            .load(self.consts.ptr_type, MEMFLAGS_READONLY, lut_ptr, 0);

        let fast_block = self.bd.create_block();
        let slow_block = self.bd.create_block();
        let continue_block = self.bd.create_block();
        self.bd.set_cold_block(slow_block);
        self.bd.append_block_param(continue_block, P::IR_TYPE);

        self.bd.ins().brif(ptr, fast_block, &[], slow_block, &[]);
        self.bd.seal_block(fast_block);
        self.bd.seal_block(slow_block);

        // fast
        self.switch_to_bb(fast_block);
        let offset = self.bd.ins().band_imm(addr, (1 << 17) - 1);
        let offset = self.extend_to_pointer_type(offset);
        let ptr = self.bd.ins().iadd(ptr, offset);
        let value = self.bd.ins().load(P::IR_TYPE, MEMFLAGS, ptr, 0);
        let value = if P::IR_TYPE != ir::types::I8 {
            self.bd.ins().bswap(value)
        } else {
            value
        };
        self.bd
            .ins()
            .jump(continue_block, &[ir::BlockArg::Value(value)]);

        // slow
        self.switch_to_bb(slow_block);
        let value = self.slow_mem_load::<P>(addr);
        self.bd
            .ins()
            .jump(continue_block, &[ir::BlockArg::Value(value)]);

        // continue
        self.bd.seal_block(continue_block);
        self.switch_to_bb(continue_block);

        self.bd.block_params(continue_block)[0]
    }

    pub fn mem_store<P: ReadWriteAble>(&mut self, addr: ir::Value, value: ir::Value) {
        if self.frontend.exit_mode == ExitMode::ReturnExecuted {
            self.portable_mem_store::<P>(addr, value);
            return;
        }

        let lut_index = self.bd.ins().ushr_imm(addr, 17);
        let lut_index = self.extend_to_pointer_type(lut_index);
        let lut_offset = self
            .bd
            .ins()
            .imul_imm(lut_index, self.consts.ptr_type.bytes() as i64);

        let lut_ptr = self.bd.ins().iadd(self.consts.fmem_ptr, lut_offset);
        let ptr = self
            .bd
            .ins()
            .load(self.consts.ptr_type, MEMFLAGS_READONLY, lut_ptr, 0);

        let fast_block = self.bd.create_block();
        let slow_block = self.bd.create_block();
        let continue_block = self.bd.create_block();
        self.bd.set_cold_block(slow_block);

        self.bd.ins().brif(ptr, fast_block, &[], slow_block, &[]);
        self.bd.seal_block(fast_block);
        self.bd.seal_block(slow_block);

        // fast
        self.switch_to_bb(fast_block);
        let offset = self.bd.ins().band_imm(addr, ((1u64 << 17) - 1) as i64);
        let offset = self.extend_to_pointer_type(offset);
        let ptr = self.bd.ins().iadd(ptr, offset);
        let value_bswap = if P::IR_TYPE != ir::types::I8 {
            self.bd.ins().bswap(value)
        } else {
            value
        };
        self.bd.ins().store(MEMFLAGS, value_bswap, ptr, 0);
        self.bd.ins().jump(continue_block, &[]);

        // slow
        self.switch_to_bb(slow_block);
        self.slow_mem_store::<P>(addr, value);
        self.bd.ins().jump(continue_block, &[]);

        // continue
        self.bd.seal_block(continue_block);
        self.switch_to_bb(continue_block);
    }

    /// Reads a quantized value. Returns the value and the type size.
    fn slow_mem_load_quant(&mut self, addr: ir::Value, gqr: ir::Value) -> (ir::Value, ir::Value) {
        let stack_slot_addr =
            self.bd
                .ins()
                .stack_addr(self.consts.ptr_type, self.consts.read_stack_slot, 0);

        self.publish_hook_cycle_offset();
        let inst = self.bd.ins().call(
            self.hooks.read_quant,
            &[self.consts.ctx_ptr, addr, gqr, stack_slot_addr],
        );

        let size = self.bd.inst_results(inst)[0];
        let exit_block = self.bd.create_block();
        let continue_block = self.bd.create_block();

        self.bd.set_cold_block(exit_block);
        self.bd
            .ins()
            .brif(size, continue_block, &[], exit_block, &[]);

        self.bd.seal_block(exit_block);
        self.bd.seal_block(continue_block);

        self.switch_to_bb(exit_block);
        self.set(SPR::DAR, addr);
        self.raise_exception(Exception::DSI);
        self.exit_with(LOAD_INFO);

        self.switch_to_bb(continue_block);
        (
            self.bd
                .ins()
                .stack_load(ir::types::F64, self.consts.read_stack_slot, 0),
            self.bd.ins().uextend(ir::types::I32, size),
        )
    }

    /// Writes a quantized value. Returns the type size.
    fn slow_mem_store_quant(
        &mut self,
        addr: ir::Value,
        gqr: ir::Value,
        value: ir::Value,
    ) -> ir::Value {
        self.publish_hook_cycle_offset();
        let inst = self.bd.ins().call(
            self.hooks.write_quant,
            &[self.consts.ctx_ptr, addr, gqr, value],
        );

        let size = self.bd.inst_results(inst)[0];
        let exit_block = self.bd.create_block();
        let continue_block = self.bd.create_block();

        self.bd.set_cold_block(exit_block);
        self.bd
            .ins()
            .brif(size, continue_block, &[], exit_block, &[]);

        self.bd.seal_block(exit_block);
        self.bd.seal_block(continue_block);

        self.switch_to_bb(exit_block);
        self.set(SPR::DAR, addr);
        self.raise_exception(Exception::DSI);
        self.exit_with(STORE_INFO);

        self.switch_to_bb(continue_block);
        self.bd.ins().uextend(ir::types::I32, size)
    }

    fn quantized_scale_factor(
        &mut self,
        gqr: ir::Value,
        field_shift: i64,
        inverse: bool,
    ) -> ir::Value {
        let scale = self.bd.ins().ushr_imm(gqr, field_shift);
        let scale = self.bd.ins().band_imm(scale, 0x3f);
        let scale = self.bd.ins().ishl_imm(scale, 26);
        let shift = self.bd.ins().iconst(ir::types::I32, 26);
        let scale = self.bd.ins().sshr(scale, shift);
        let exponent_bias = self.bd.ins().iconst(ir::types::I32, 1023);
        let exponent = if inverse {
            let inverse_scale = self.bd.ins().ineg(scale);
            self.bd.ins().iadd(exponent_bias, inverse_scale)
        } else {
            self.bd.ins().iadd(exponent_bias, scale)
        };
        let exponent = self.bd.ins().sextend(ir::types::I64, exponent);
        let fraction_unit = self.bd.ins().iconst(ir::types::I64, 1i64 << 52);
        let bits = self.bd.ins().imul(exponent, fraction_unit);
        self.bd
            .ins()
            .bitcast(ir::types::F64, ir::MemFlags::new(), bits)
    }

    fn portable_quantized_load_float(&mut self, pointer: ir::Value) -> ir::Value {
        let bits = self.bd.ins().load(ir::types::I32, MEMFLAGS, pointer, 0);
        let bits = self.bd.ins().bswap(bits);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::F32, ir::MemFlags::new(), bits);
        self.bd.ins().fpromote(ir::types::F64, value)
    }

    fn portable_quantized_load_integer<P: ReadWriteAble>(
        &mut self,
        pointer: ir::Value,
        signed: bool,
        factor: ir::Value,
    ) -> ir::Value {
        let value = self.bd.ins().load(P::IR_TYPE, MEMFLAGS, pointer, 0);
        let value = if signed {
            self.bd.ins().sextend(ir::types::I32, value)
        } else {
            self.bd.ins().uextend(ir::types::I32, value)
        };
        let value = if signed {
            self.bd.ins().fcvt_from_sint(ir::types::F64, value)
        } else {
            self.bd.ins().fcvt_from_uint(ir::types::F64, value)
        };
        self.bd.ins().fmul(value, factor)
    }

    fn mem_load_quant(&mut self, addr: ir::Value, gqr: ir::Value) -> (ir::Value, ir::Value) {
        if self.frontend.exit_mode != ExitMode::ReturnExecutedWithSlowMemory {
            return self.slow_mem_load_quant(addr, gqr);
        }

        let lut_index = self.bd.ins().ushr_imm(addr, 17);
        let lut_index = self.extend_to_pointer_type(lut_index);
        let lut_offset = self
            .bd
            .ins()
            .imul_imm(lut_index, self.consts.ptr_type.bytes() as i64);
        let lut_ptr = self.bd.ins().iadd(self.consts.fmem_ptr, lut_offset);
        let page = self
            .bd
            .ins()
            .load(self.consts.ptr_type, MEMFLAGS_READONLY, lut_ptr, 0);

        let fast_block = self.bd.create_block();
        let slow_block = self.bd.create_block();
        let continue_block = self.bd.create_block();
        self.bd.set_cold_block(slow_block);
        self.bd.append_block_param(continue_block, ir::types::F64);
        self.bd.append_block_param(continue_block, ir::types::I32);
        self.bd.ins().brif(page, fast_block, &[], slow_block, &[]);
        self.bd.seal_block(fast_block);

        self.switch_to_bb(fast_block);
        let offset = self.bd.ins().band_imm(addr, (1 << 17) - 1);
        let offset = self.extend_to_pointer_type(offset);
        let pointer = self.bd.ins().iadd(page, offset);
        let quant_type = self.bd.ins().ushr_imm(gqr, 16);
        let quant_type = self.bd.ins().band_imm(quant_type, 7);
        let factor = self.quantized_scale_factor(gqr, 24, true);

        let float_block = self.bd.create_block();
        let check_u8_block = self.bd.create_block();
        let u8_block = self.bd.create_block();
        let check_u16_block = self.bd.create_block();
        let u16_block = self.bd.create_block();
        let check_i8_block = self.bd.create_block();
        let i8_block = self.bd.create_block();
        let check_i16_block = self.bd.create_block();
        let i16_block = self.bd.create_block();

        let is_float = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 0);
        self.bd
            .ins()
            .brif(is_float, float_block, &[], check_u8_block, &[]);
        self.bd.seal_block(float_block);
        self.bd.seal_block(check_u8_block);

        self.switch_to_bb(float_block);
        let value = self.portable_quantized_load_float(pointer);
        let size = self.bd.ins().iconst(ir::types::I32, 4);
        self.bd.ins().jump(
            continue_block,
            &[ir::BlockArg::Value(value), ir::BlockArg::Value(size)],
        );

        self.switch_to_bb(check_u8_block);
        let is_u8 = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 4);
        self.bd
            .ins()
            .brif(is_u8, u8_block, &[], check_u16_block, &[]);
        self.bd.seal_block(u8_block);
        self.bd.seal_block(check_u16_block);

        self.switch_to_bb(u8_block);
        let value = self.portable_quantized_load_integer::<i8>(pointer, false, factor);
        let size = self.bd.ins().iconst(ir::types::I32, 1);
        self.bd.ins().jump(
            continue_block,
            &[ir::BlockArg::Value(value), ir::BlockArg::Value(size)],
        );

        self.switch_to_bb(check_u16_block);
        let is_u16 = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 5);
        self.bd
            .ins()
            .brif(is_u16, u16_block, &[], check_i8_block, &[]);
        self.bd.seal_block(u16_block);
        self.bd.seal_block(check_i8_block);

        self.switch_to_bb(u16_block);
        let value = self.portable_quantized_load_integer::<i16>(pointer, false, factor);
        let size = self.bd.ins().iconst(ir::types::I32, 2);
        self.bd.ins().jump(
            continue_block,
            &[ir::BlockArg::Value(value), ir::BlockArg::Value(size)],
        );

        self.switch_to_bb(check_i8_block);
        let is_i8 = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 6);
        self.bd
            .ins()
            .brif(is_i8, i8_block, &[], check_i16_block, &[]);
        self.bd.seal_block(i8_block);
        self.bd.seal_block(check_i16_block);

        self.switch_to_bb(i8_block);
        let value = self.portable_quantized_load_integer::<i8>(pointer, true, factor);
        let size = self.bd.ins().iconst(ir::types::I32, 1);
        self.bd.ins().jump(
            continue_block,
            &[ir::BlockArg::Value(value), ir::BlockArg::Value(size)],
        );

        self.switch_to_bb(check_i16_block);
        let is_i16 = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 7);
        self.bd.ins().brif(is_i16, i16_block, &[], slow_block, &[]);
        self.bd.seal_block(i16_block);
        self.bd.seal_block(slow_block);

        self.switch_to_bb(i16_block);
        let value = self.portable_quantized_load_integer::<i16>(pointer, true, factor);
        let size = self.bd.ins().iconst(ir::types::I32, 2);
        self.bd.ins().jump(
            continue_block,
            &[ir::BlockArg::Value(value), ir::BlockArg::Value(size)],
        );

        self.switch_to_bb(slow_block);
        let (value, size) = self.slow_mem_load_quant(addr, gqr);
        self.bd.ins().jump(
            continue_block,
            &[ir::BlockArg::Value(value), ir::BlockArg::Value(size)],
        );

        self.bd.seal_block(continue_block);
        self.switch_to_bb(continue_block);
        let parameters = self.bd.block_params(continue_block);
        (parameters[0], parameters[1])
    }

    fn portable_quantized_store_float(&mut self, pointer: ir::Value, value: ir::Value) {
        let value = self.bd.ins().fdemote(ir::types::F32, value);
        let bits = self
            .bd
            .ins()
            .bitcast(ir::types::I32, ir::MemFlags::new(), value);
        let bits = self.bd.ins().bswap(bits);
        self.bd.ins().store(MEMFLAGS, bits, pointer, 0);
    }

    fn portable_quantized_store_integer<P: ReadWriteAble>(
        &mut self,
        pointer: ir::Value,
        value: ir::Value,
        signed: bool,
        minimum: i32,
        maximum: i32,
        factor: ir::Value,
    ) {
        let scaled = self.bd.ins().fmul(value, factor);
        let converted = if signed {
            self.bd.ins().fcvt_to_sint_sat(ir::types::I32, scaled)
        } else {
            self.bd.ins().fcvt_to_uint_sat(ir::types::I32, scaled)
        };
        let converted = if signed {
            let below =
                self.bd
                    .ins()
                    .icmp_imm(IntCC::SignedLessThan, converted, i64::from(minimum));
            let minimum = self.bd.ins().iconst(ir::types::I32, i64::from(minimum));
            self.bd.ins().select(below, minimum, converted)
        } else {
            converted
        };
        let above = self.bd.ins().icmp_imm(
            if signed {
                IntCC::SignedGreaterThan
            } else {
                IntCC::UnsignedGreaterThan
            },
            converted,
            i64::from(maximum),
        );
        let maximum = self.bd.ins().iconst(ir::types::I32, i64::from(maximum));
        let converted = self.bd.ins().select(above, maximum, converted);
        let stored = self.bd.ins().ireduce(P::IR_TYPE, converted);
        let stored = if P::IR_TYPE == ir::types::I8 {
            stored
        } else {
            self.bd.ins().bswap(stored)
        };
        self.bd.ins().store(MEMFLAGS, stored, pointer, 0);
    }

    fn mem_store_quant(&mut self, addr: ir::Value, gqr: ir::Value, value: ir::Value) -> ir::Value {
        if self.frontend.exit_mode != ExitMode::ReturnExecutedWithSlowMemory {
            return self.slow_mem_store_quant(addr, gqr, value);
        }

        let lut_index = self.bd.ins().ushr_imm(addr, 17);
        let lut_index = self.extend_to_pointer_type(lut_index);
        let lut_offset = self
            .bd
            .ins()
            .imul_imm(lut_index, self.consts.ptr_type.bytes() as i64);
        let lut_ptr = self.bd.ins().iadd(self.consts.fmem_ptr, lut_offset);
        let page = self
            .bd
            .ins()
            .load(self.consts.ptr_type, MEMFLAGS_READONLY, lut_ptr, 0);

        let fast_block = self.bd.create_block();
        let slow_block = self.bd.create_block();
        let continue_block = self.bd.create_block();
        self.bd.set_cold_block(slow_block);
        self.bd.append_block_param(continue_block, ir::types::I32);
        self.bd.ins().brif(page, fast_block, &[], slow_block, &[]);
        self.bd.seal_block(fast_block);

        self.switch_to_bb(fast_block);
        let offset = self.bd.ins().band_imm(addr, (1 << 17) - 1);
        let offset = self.extend_to_pointer_type(offset);
        let pointer = self.bd.ins().iadd(page, offset);
        let quant_type = self.bd.ins().band_imm(gqr, 7);
        let factor = self.quantized_scale_factor(gqr, 8, false);

        let float_block = self.bd.create_block();
        let check_u8_block = self.bd.create_block();
        let u8_block = self.bd.create_block();
        let check_u16_block = self.bd.create_block();
        let u16_block = self.bd.create_block();
        let check_i8_block = self.bd.create_block();
        let i8_block = self.bd.create_block();
        let check_i16_block = self.bd.create_block();
        let i16_block = self.bd.create_block();

        let is_float = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 0);
        self.bd
            .ins()
            .brif(is_float, float_block, &[], check_u8_block, &[]);
        self.bd.seal_block(float_block);
        self.bd.seal_block(check_u8_block);

        self.switch_to_bb(float_block);
        self.portable_quantized_store_float(pointer, value);
        let size = self.bd.ins().iconst(ir::types::I32, 4);
        self.bd
            .ins()
            .jump(continue_block, &[ir::BlockArg::Value(size)]);

        self.switch_to_bb(check_u8_block);
        let is_u8 = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 4);
        self.bd
            .ins()
            .brif(is_u8, u8_block, &[], check_u16_block, &[]);
        self.bd.seal_block(u8_block);
        self.bd.seal_block(check_u16_block);

        self.switch_to_bb(u8_block);
        self.portable_quantized_store_integer::<i8>(pointer, value, false, 0, 255, factor);
        let size = self.bd.ins().iconst(ir::types::I32, 1);
        self.bd
            .ins()
            .jump(continue_block, &[ir::BlockArg::Value(size)]);

        self.switch_to_bb(check_u16_block);
        let is_u16 = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 5);
        self.bd
            .ins()
            .brif(is_u16, u16_block, &[], check_i8_block, &[]);
        self.bd.seal_block(u16_block);
        self.bd.seal_block(check_i8_block);

        self.switch_to_bb(u16_block);
        self.portable_quantized_store_integer::<i16>(pointer, value, false, 0, 65535, factor);
        let size = self.bd.ins().iconst(ir::types::I32, 2);
        self.bd
            .ins()
            .jump(continue_block, &[ir::BlockArg::Value(size)]);

        self.switch_to_bb(check_i8_block);
        let is_i8 = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 6);
        self.bd
            .ins()
            .brif(is_i8, i8_block, &[], check_i16_block, &[]);
        self.bd.seal_block(i8_block);
        self.bd.seal_block(check_i16_block);

        self.switch_to_bb(i8_block);
        self.portable_quantized_store_integer::<i8>(pointer, value, true, -128, 127, factor);
        let size = self.bd.ins().iconst(ir::types::I32, 1);
        self.bd
            .ins()
            .jump(continue_block, &[ir::BlockArg::Value(size)]);

        self.switch_to_bb(check_i16_block);
        let is_i16 = self.bd.ins().icmp_imm(IntCC::Equal, quant_type, 7);
        self.bd.ins().brif(is_i16, i16_block, &[], slow_block, &[]);
        self.bd.seal_block(i16_block);
        self.bd.seal_block(slow_block);

        self.switch_to_bb(i16_block);
        self.portable_quantized_store_integer::<i16>(pointer, value, true, -32768, 32767, factor);
        let size = self.bd.ins().iconst(ir::types::I32, 2);
        self.bd
            .ins()
            .jump(continue_block, &[ir::BlockArg::Value(size)]);

        self.switch_to_bb(slow_block);
        let size = self.slow_mem_store_quant(addr, gqr, value);
        self.bd
            .ins()
            .jump(continue_block, &[ir::BlockArg::Value(size)]);

        self.bd.seal_block(continue_block);
        self.switch_to_bb(continue_block);
        self.bd.block_params(continue_block)[0]
    }
}

const LOAD_INFO: InstructionInfo = InstructionInfo {
    cycles: 2,
    auto_pc: true,
    action: Action::Continue,
};

#[derive(Clone, Copy)]
struct LoadOp {
    update: bool,
    signed: bool,
    reverse: bool,
}

/// GPR load operations
impl BlockBuilder<'_> {
    fn load<P: ReadWriteAble>(&mut self, ins: Ins, op: LoadOp) -> InstructionInfo {
        let addr = if !op.update && ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let mut value = self.mem_load::<P>(addr);
        if P::IR_TYPE != ir::types::I32 {
            value = if op.signed {
                self.bd.ins().sextend(ir::types::I32, value)
            } else {
                self.bd.ins().uextend(ir::types::I32, value)
            };
        }

        if op.update {
            self.set(ins.gpr_a(), addr);
        }

        self.set(ins.gpr_d(), value);

        LOAD_INFO
    }

    fn load_indexed<P: ReadWriteAble>(&mut self, ins: Ins, op: LoadOp) -> InstructionInfo {
        let rb = self.get(ins.gpr_b());
        let addr = if !op.update && ins.field_ra() == 0 {
            rb
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd(ra, rb)
        };

        let mut value = self.mem_load::<P>(addr);

        if op.reverse {
            value = self.bd.ins().bswap(value);
        }

        if P::IR_TYPE != ir::types::I32 {
            value = if op.signed {
                self.bd.ins().sextend(ir::types::I32, value)
            } else {
                self.bd.ins().uextend(ir::types::I32, value)
            };
        }

        if op.update {
            self.set(ins.gpr_a(), addr);
        }

        self.set(ins.gpr_d(), value);

        LOAD_INFO
    }

    pub fn lbz(&mut self, ins: Ins) -> InstructionInfo {
        self.load::<i8>(
            ins,
            LoadOp {
                update: false,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lbzx(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i8>(
            ins,
            LoadOp {
                update: false,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lbzu(&mut self, ins: Ins) -> InstructionInfo {
        self.load::<i8>(
            ins,
            LoadOp {
                update: true,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lbzux(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i8>(
            ins,
            LoadOp {
                update: true,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lhz(&mut self, ins: Ins) -> InstructionInfo {
        self.load::<i16>(
            ins,
            LoadOp {
                update: false,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lhzx(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i16>(
            ins,
            LoadOp {
                update: false,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lhzu(&mut self, ins: Ins) -> InstructionInfo {
        self.load::<i16>(
            ins,
            LoadOp {
                update: true,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lhzux(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i16>(
            ins,
            LoadOp {
                update: true,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lha(&mut self, ins: Ins) -> InstructionInfo {
        self.load::<i16>(
            ins,
            LoadOp {
                update: false,
                signed: true,
                reverse: false,
            },
        )
    }

    pub fn lhax(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i16>(
            ins,
            LoadOp {
                update: false,
                signed: true,
                reverse: false,
            },
        )
    }

    pub fn lhau(&mut self, ins: Ins) -> InstructionInfo {
        self.load::<i16>(
            ins,
            LoadOp {
                update: true,
                signed: true,
                reverse: false,
            },
        )
    }

    pub fn lhaux(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i16>(
            ins,
            LoadOp {
                update: true,
                signed: true,
                reverse: false,
            },
        )
    }

    pub fn lhbrx(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i16>(
            ins,
            LoadOp {
                update: false,
                signed: false,
                reverse: true,
            },
        )
    }

    pub fn lwz(&mut self, ins: Ins) -> InstructionInfo {
        self.load::<i32>(
            ins,
            LoadOp {
                update: false,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lwzx(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i32>(
            ins,
            LoadOp {
                update: false,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lwzu(&mut self, ins: Ins) -> InstructionInfo {
        self.load::<i32>(
            ins,
            LoadOp {
                update: true,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lwzux(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i32>(
            ins,
            LoadOp {
                update: true,
                signed: false,
                reverse: false,
            },
        )
    }

    pub fn lwbrx(&mut self, ins: Ins) -> InstructionInfo {
        self.load_indexed::<i32>(
            ins,
            LoadOp {
                update: false,
                signed: false,
                reverse: true,
            },
        )
    }

    pub fn lmw(&mut self, ins: Ins) -> InstructionInfo {
        let mut addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        for i in ins.field_rd()..32 {
            let value = self.mem_load::<i32>(addr);
            self.set(GPR::new(i), value);

            addr = self.bd.ins().iadd_imm(addr, 4);
        }

        InstructionInfo {
            cycles: 10, // random, chosen by fair dice roll
            ..LOAD_INFO
        }
    }

    pub fn lswi(&mut self, ins: Ins) -> InstructionInfo {
        let mut addr = if ins.field_ra() == 0 {
            self.ir_value(0)
        } else {
            self.get(ins.gpr_a())
        };

        let byte_count = if ins.field_nb() != 0 {
            ins.field_nb()
        } else {
            32
        };

        let zero = self.ir_value(0);
        let start_reg = ins.field_rd();
        for i in 0..byte_count {
            let reg = GPR::new((start_reg + i / 4) % 32);
            let shift_count = 8 * (3 - (i as u32 % 4));

            let value = self.mem_load::<i8>(addr);
            let value = self.bd.ins().uextend(ir::types::I32, value);
            let value = self.bd.ins().ishl_imm(value, shift_count as u64 as i64);

            let current = self.get(reg);
            let mask = self.ir_value(0xFFu32 << shift_count);
            let loaded = self.bd.ins().bitselect(mask, value, current);

            let clear_mask = self.ir_value(0xFFFF_FFFFu32 << shift_count);
            let new = self.bd.ins().bitselect(clear_mask, loaded, zero);

            self.set(reg, new);
            addr = self.bd.ins().iadd_imm(addr, 1);
        }

        InstructionInfo {
            cycles: 10, // random, chosen by fair dice roll
            ..LOAD_INFO
        }
    }

    pub fn lfd(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let value = self.mem_load::<i64>(addr);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::F64, ir::MemFlags::new(), value);

        let paired = self.bd.ins().splat(ir::types::F64X2, value);
        self.set(ins.fpr_d(), paired);

        LOAD_INFO
    }

    pub fn lfdu(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let value = self.mem_load::<i64>(addr);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::F64, ir::MemFlags::new(), value);

        let paired = self.bd.ins().splat(ir::types::F64X2, value);
        self.set(ins.fpr_d(), paired);
        self.set(ins.gpr_a(), addr);

        LOAD_INFO
    }

    pub fn lfdx(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let rb = self.get(ins.gpr_b());
        let addr = if ins.field_ra() == 0 {
            rb
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd(ra, rb)
        };

        let value = self.mem_load::<i64>(addr);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::F64, ir::MemFlags::new(), value);

        let paired = self.bd.ins().splat(ir::types::F64X2, value);
        self.set(ins.fpr_d(), paired);

        LOAD_INFO
    }

    pub fn lfdux(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let ra = self.get(ins.gpr_a());
        let rb = self.get(ins.gpr_b());
        let addr = self.bd.ins().iadd(ra, rb);

        let value = self.mem_load::<i64>(addr);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::F64, ir::MemFlags::new(), value);

        let paired = self.bd.ins().splat(ir::types::F64X2, value);
        self.set(ins.fpr_d(), paired);
        self.set(ins.gpr_a(), addr);

        LOAD_INFO
    }

    pub fn lfs(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let value = self.mem_load::<i32>(addr);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::F32, ir::MemFlags::new(), value);

        let double = self.bd.ins().fpromote(ir::types::F64, value);
        let paired = self.bd.ins().splat(ir::types::F64X2, double);
        self.set(ins.fpr_d(), paired);

        LOAD_INFO
    }

    pub fn lfsu(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let value = self.mem_load::<i32>(addr);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::F32, ir::MemFlags::new(), value);

        let double = self.bd.ins().fpromote(ir::types::F64, value);
        let paired = self.bd.ins().splat(ir::types::F64X2, double);
        self.set(ins.fpr_d(), paired);
        self.set(ins.gpr_a(), addr);

        LOAD_INFO
    }

    pub fn lfsx(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let rb = self.get(ins.gpr_b());
        let addr = if ins.field_ra() == 0 {
            rb
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd(ra, rb)
        };

        let value = self.mem_load::<i32>(addr);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::F32, ir::MemFlags::new(), value);

        let double = self.bd.ins().fpromote(ir::types::F64, value);
        let paired = self.bd.ins().splat(ir::types::F64X2, double);
        self.set(ins.fpr_d(), paired);

        LOAD_INFO
    }

    pub fn lfsux(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let ra = self.get(ins.gpr_a());
        let rb = self.get(ins.gpr_b());
        let addr = self.bd.ins().iadd(ra, rb);

        let value = self.mem_load::<i32>(addr);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::F32, ir::MemFlags::new(), value);

        let double = self.bd.ins().fpromote(ir::types::F64, value);
        let paired = self.bd.ins().splat(ir::types::F64X2, double);
        self.set(ins.fpr_d(), paired);
        self.set(ins.gpr_a(), addr);

        LOAD_INFO
    }
}

const STORE_INFO: InstructionInfo = InstructionInfo {
    cycles: 2,
    auto_pc: true,
    action: Action::Continue,
};

/// Store operations
impl BlockBuilder<'_> {
    fn store<P: ReadWriteAble>(&mut self, ins: Ins, update: bool) -> InstructionInfo {
        let addr = if !update && ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let mut value = self.get(ins.gpr_s());
        if P::IR_TYPE != ir::types::I32 {
            value = self.bd.ins().ireduce(P::IR_TYPE, value);
        }

        if update {
            self.set(ins.gpr_a(), addr);
        }

        self.mem_store::<P>(addr, value);

        STORE_INFO
    }

    fn store_indexed<P: ReadWriteAble>(
        &mut self,
        ins: Ins,
        update: bool,
        reverse: bool,
    ) -> InstructionInfo {
        let rb = self.get(ins.gpr_b());
        let addr = if !update && ins.field_ra() == 0 {
            rb
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd(ra, rb)
        };

        let mut value = self.get(ins.gpr_s());
        if P::IR_TYPE != ir::types::I32 {
            value = self.bd.ins().ireduce(P::IR_TYPE, value);
        }

        if reverse {
            value = self.bd.ins().bswap(value);
        }

        if update {
            self.set(ins.gpr_a(), addr);
        }

        self.mem_store::<P>(addr, value);

        STORE_INFO
    }

    pub fn stb(&mut self, ins: Ins) -> InstructionInfo {
        self.store::<i8>(ins, false)
    }

    pub fn stbx(&mut self, ins: Ins) -> InstructionInfo {
        self.store_indexed::<i8>(ins, false, false)
    }

    pub fn stbu(&mut self, ins: Ins) -> InstructionInfo {
        self.store::<i8>(ins, true)
    }

    pub fn stbux(&mut self, ins: Ins) -> InstructionInfo {
        self.store_indexed::<i8>(ins, true, false)
    }

    pub fn sth(&mut self, ins: Ins) -> InstructionInfo {
        self.store::<i16>(ins, false)
    }

    pub fn sthx(&mut self, ins: Ins) -> InstructionInfo {
        self.store_indexed::<i16>(ins, false, false)
    }

    pub fn sthbrx(&mut self, ins: Ins) -> InstructionInfo {
        self.store_indexed::<i16>(ins, false, true)
    }

    pub fn sthu(&mut self, ins: Ins) -> InstructionInfo {
        self.store::<i16>(ins, true)
    }

    pub fn sthux(&mut self, ins: Ins) -> InstructionInfo {
        self.store_indexed::<i16>(ins, true, false)
    }

    pub fn stw(&mut self, ins: Ins) -> InstructionInfo {
        self.store::<i32>(ins, false)
    }

    pub fn stwx(&mut self, ins: Ins) -> InstructionInfo {
        self.store_indexed::<i32>(ins, false, false)
    }

    pub fn stwbrx(&mut self, ins: Ins) -> InstructionInfo {
        self.store_indexed::<i32>(ins, false, true)
    }

    pub fn stwu(&mut self, ins: Ins) -> InstructionInfo {
        self.store::<i32>(ins, true)
    }

    pub fn stwux(&mut self, ins: Ins) -> InstructionInfo {
        self.store_indexed::<i32>(ins, true, false)
    }

    pub fn stmw(&mut self, ins: Ins) -> InstructionInfo {
        let mut addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        for i in ins.field_rs()..32 {
            let value = self.get(GPR::new(i));
            self.mem_store::<i32>(addr, value);

            addr = self.bd.ins().iadd_imm(addr, 4);
        }

        InstructionInfo {
            cycles: 10, // random, chosen by fair dice roll
            ..STORE_INFO
        }
    }

    pub fn stswi(&mut self, ins: Ins) -> InstructionInfo {
        let mut addr = if ins.field_ra() == 0 {
            self.ir_value(0)
        } else {
            self.get(ins.gpr_a())
        };

        let byte_count = if ins.field_nb() != 0 {
            ins.field_nb()
        } else {
            32
        };

        let start_reg = ins.field_rd();
        for i in 0..byte_count {
            let reg = GPR::new((start_reg + i / 4) % 32);
            let shift_count = 8 * (3 - (i as u32 % 4));

            let reg = self.get(reg);
            let value = self.bd.ins().ushr_imm(reg, shift_count as u64 as i64);
            let value = self.bd.ins().ireduce(ir::types::I8, value);

            self.mem_store::<i8>(addr, value);
            addr = self.bd.ins().iadd_imm(addr, 1);
        }

        InstructionInfo {
            cycles: 10, // random, chosen by fair dice roll
            ..LOAD_INFO
        }
    }

    pub fn stfd(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let value = self.get(ins.fpr_s());
        let value = self.bd.ins().extractlane(value, 0);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::I64, ir::MemFlags::new(), value);

        self.mem_store::<i64>(addr, value);

        STORE_INFO
    }

    pub fn stfdu(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let value = self.get(ins.fpr_s());
        let value = self.bd.ins().extractlane(value, 0);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::I64, ir::MemFlags::new(), value);

        self.mem_store::<i64>(addr, value);
        self.set(ins.gpr_a(), addr);

        STORE_INFO
    }

    pub fn stfdx(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let rb = self.get(ins.gpr_b());
        let addr = if ins.field_ra() == 0 {
            rb
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd(ra, rb)
        };

        let value = self.get(ins.fpr_s());
        let value = self.bd.ins().extractlane(value, 0);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::I64, ir::MemFlags::new(), value);

        self.mem_store::<i64>(addr, value);

        STORE_INFO
    }

    pub fn stfdux(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let ra = self.get(ins.gpr_a());
        let rb = self.get(ins.gpr_b());
        let addr = self.bd.ins().iadd(ra, rb);

        let value = self.get(ins.fpr_s());
        let value = self.bd.ins().extractlane(value, 0);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::I64, ir::MemFlags::new(), value);

        self.mem_store::<i64>(addr, value);
        self.set(ins.gpr_a(), addr);

        STORE_INFO
    }

    pub fn stfs(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let value = self.get(ins.fpr_s());
        let value = self.bd.ins().extractlane(value, 0);
        let value = self.bd.ins().fdemote(ir::types::F32, value);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::I32, ir::MemFlags::new(), value);

        self.mem_store::<i32>(addr, value);

        STORE_INFO
    }

    pub fn stfsu(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_offset() as i64)
        };

        let value = self.get(ins.fpr_s());
        let value = self.bd.ins().extractlane(value, 0);
        let value = self.bd.ins().fdemote(ir::types::F32, value);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::I32, ir::MemFlags::new(), value);

        self.mem_store::<i32>(addr, value);
        self.set(ins.gpr_a(), addr);

        STORE_INFO
    }

    pub fn stfsx(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let rb = self.get(ins.gpr_b());
        let addr = if ins.field_ra() == 0 {
            rb
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd(ra, rb)
        };

        let value = self.get(ins.fpr_s());
        let value = self.bd.ins().extractlane(value, 0);
        let value = self.bd.ins().fdemote(ir::types::F32, value);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::I32, ir::MemFlags::new(), value);

        self.mem_store::<i32>(addr, value);

        STORE_INFO
    }

    pub fn stfsux(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let ra = self.get(ins.gpr_a());
        let rb = self.get(ins.gpr_b());
        let addr = self.bd.ins().iadd(ra, rb);

        let value = self.get(ins.fpr_s());
        let value = self.bd.ins().extractlane(value, 0);
        let value = self.bd.ins().fdemote(ir::types::F32, value);
        let value = self
            .bd
            .ins()
            .bitcast(ir::types::I32, ir::MemFlags::new(), value);

        self.mem_store::<i32>(addr, value);
        self.set(ins.gpr_a(), addr);

        STORE_INFO
    }

    pub fn stfiwx(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let rb = self.get(ins.gpr_b());
        let addr = if ins.field_ra() == 0 {
            rb
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd(ra, rb)
        };

        let fpr_s = self.get(ins.fpr_s());
        let fpr_s_ps0 = self.bd.ins().extractlane(fpr_s, 0);
        let int64 = self
            .bd
            .ins()
            .bitcast(ir::types::I64, ir::MemFlags::new(), fpr_s_ps0);
        let int32 = self.bd.ins().ireduce(ir::types::I32, int64);

        self.mem_store::<i32>(addr, int32);

        STORE_INFO
    }

    pub fn stwcx(&mut self, ins: Ins) -> InstructionInfo {
        self.stwx(ins);

        let zero = self.ir_value(0);
        self.update_cr0_cmpz(zero);

        STORE_INFO
    }

    pub fn psq_l(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_ps_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_ps_offset() as i64)
        };

        let gqr = self.get(SPR::GQR[ins.field_ps_i() as usize]);
        let (ps0, size) = self.mem_load_quant(addr, gqr);
        let ps1 = if ins.field_ps_w() == 0 {
            let addr = self.bd.ins().iadd(addr, size);
            self.mem_load_quant(addr, gqr).0
        } else {
            self.ir_value(1.0f64)
        };

        let value = self.bd.ins().scalar_to_vector(ir::types::F64X2, ps0);
        let value = self.bd.ins().insertlane(value, ps1, 1);
        self.set(ins.fpr_d(), value);

        LOAD_INFO
    }

    pub fn psq_lu(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_ps_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_ps_offset() as i64)
        };

        let gqr = self.get(SPR::GQR[ins.field_ps_i() as usize]);
        let (ps0, size) = self.mem_load_quant(addr, gqr);
        let ps1 = if ins.field_ps_w() == 0 {
            let addr = self.bd.ins().iadd(addr, size);
            self.mem_load_quant(addr, gqr).0
        } else {
            self.ir_value(1.0f64)
        };

        let value = self.bd.ins().scalar_to_vector(ir::types::F64X2, ps0);
        let value = self.bd.ins().insertlane(value, ps1, 1);
        self.set(ins.fpr_d(), value);
        self.set(ins.gpr_a(), addr);

        LOAD_INFO
    }

    pub fn psq_lx(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let rb = self.get(ins.gpr_b());
        let addr = if ins.field_ra() == 0 {
            rb
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd(ra, rb)
        };

        let gqr = self.get(SPR::GQR[ins.field_ps_i() as usize]);
        let (ps0, size) = self.mem_load_quant(addr, gqr);
        let ps1 = if ins.field_ps_w() == 0 {
            let addr = self.bd.ins().iadd(addr, size);
            self.mem_load_quant(addr, gqr).0
        } else {
            self.ir_value(1.0f64)
        };

        let value = self.bd.ins().scalar_to_vector(ir::types::F64X2, ps0);
        let value = self.bd.ins().insertlane(value, ps1, 1);
        self.set(ins.fpr_d(), value);

        LOAD_INFO
    }

    pub fn psq_st(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_ps_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_ps_offset() as i64)
        };

        let fpr_s = self.get(ins.fpr_s());
        let ps0 = self.bd.ins().extractlane(fpr_s, 0);
        let gqr = self.get(SPR::GQR[ins.field_ps_i() as usize]);

        let size = self.mem_store_quant(addr, gqr, ps0);
        if ins.field_ps_w() == 0 {
            let ps1 = self.bd.ins().extractlane(fpr_s, 1);
            let addr = self.bd.ins().iadd(addr, size);
            self.mem_store_quant(addr, gqr, ps1);
        }

        STORE_INFO
    }

    pub fn psq_stu(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let addr = if ins.field_ra() == 0 {
            self.ir_value(ins.field_ps_offset() as i32)
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd_imm(ra, ins.field_ps_offset() as i64)
        };

        let fpr_s = self.get(ins.fpr_s());
        let ps0 = self.bd.ins().extractlane(fpr_s, 0);
        let gqr = self.get(SPR::GQR[ins.field_ps_i() as usize]);

        let size = self.mem_store_quant(addr, gqr, ps0);
        if ins.field_ps_w() == 0 {
            let ps1 = self.bd.ins().extractlane(fpr_s, 1);
            let addr = self.bd.ins().iadd(addr, size);
            self.mem_store_quant(addr, gqr, ps1);
        }

        self.set(ins.gpr_a(), addr);

        STORE_INFO
    }

    pub fn psq_stx(&mut self, ins: Ins) -> InstructionInfo {
        self.check_floats();

        let rb = self.get(ins.gpr_b());
        let addr = if ins.field_ra() == 0 {
            rb
        } else {
            let ra = self.get(ins.gpr_a());
            self.bd.ins().iadd(ra, rb)
        };

        let fpr_s = self.get(ins.fpr_s());
        let ps0 = self.bd.ins().extractlane(fpr_s, 0);
        let gqr = self.get(SPR::GQR[ins.field_ps_i() as usize]);

        let size = self.mem_store_quant(addr, gqr, ps0);
        if ins.field_ps_w() == 0 {
            let ps1 = self.bd.ins().extractlane(fpr_s, 1);
            let addr = self.bd.ins().iadd(addr, size);
            self.mem_store_quant(addr, gqr, ps1);
        }

        STORE_INFO
    }
}
