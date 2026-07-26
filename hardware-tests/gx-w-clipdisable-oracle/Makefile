# SPDX-License-Identifier: GPL-3.0-only

.SUFFIXES:

ifeq ($(strip $(DEVKITPPC)),)
$(error "Set DEVKITPPC to a devkitPPC installation")
endif

PLATFORM ?= gamecube
export PLATFORM

ifeq ($(PLATFORM),gamecube)
include $(DEVKITPPC)/gamecube_rules
PLATFORM_LIBS := -lfat -logc -lm
else ifeq ($(PLATFORM),wii)
include $(DEVKITPPC)/wii_rules
PLATFORM_LIBS := -lfat -lwiiuse -lbte -logc -lm
else
$(error "PLATFORM must be gamecube or wii")
endif

TARGET := gx-w-clipdisable-oracle-$(PLATFORM)
BUILD := build-$(PLATFORM)
SOURCES := source
DATA :=
INCLUDES :=

CFLAGS = -g -O2 -std=gnu11 -Wall -Wextra $(MACHDEP) $(INCLUDE)
CXXFLAGS = $(CFLAGS)
LDFLAGS = -g $(MACHDEP) \
	-Wl,-Map,$(notdir $@).map \
	-Wl,--section-start=.oracle_mailbox=0x81700000
LIBS := $(PLATFORM_LIBS)
LIBDIRS :=

ifneq ($(BUILD),$(notdir $(CURDIR)))

export OUTPUT := $(CURDIR)/$(TARGET)
export VPATH := $(foreach dir,$(SOURCES),$(CURDIR)/$(dir))
export DEPSDIR := $(CURDIR)/$(BUILD)

CFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.c)))
CPPFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.cpp)))
sFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.s)))
SFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.S)))

ifeq ($(strip $(CPPFILES)),)
export LD := $(CC)
else
export LD := $(CXX)
endif

export OFILES := $(CPPFILES:.cpp=.o) $(CFILES:.c=.o) \
	$(sFILES:.s=.o) $(SFILES:.S=.o)
export INCLUDE := $(foreach dir,$(INCLUDES),-I$(CURDIR)/$(dir)) \
	$(foreach dir,$(LIBDIRS),-I$(dir)/include) \
	-I$(CURDIR)/$(BUILD) \
	-I$(LIBOGC_INC)
export LIBPATHS := -L$(LIBOGC_LIB) \
	$(foreach dir,$(LIBDIRS),-L$(dir)/lib)

.PHONY: $(BUILD) clean

$(BUILD):
	@[ -d $@ ] || mkdir -p $@
	@$(MAKE) --no-print-directory -C $(BUILD) -f $(CURDIR)/Makefile PLATFORM=$(PLATFORM)

clean:
	@echo clean ...
	@rm -fr build-gamecube build-wii \
		gx-w-clipdisable-oracle-gamecube.elf \
		gx-w-clipdisable-oracle-gamecube.dol \
		gx-w-clipdisable-oracle-wii.elf \
		gx-w-clipdisable-oracle-wii.dol

else

DEPENDS := $(OFILES:.o=.d)

$(OUTPUT).dol: $(OUTPUT).elf
$(OUTPUT).elf: $(OFILES)

-include $(DEPENDS)

endif
