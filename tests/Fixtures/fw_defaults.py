# Dumps the firmware's own defaults (stParams[].nDefaultVal, core/param_registry.h) from a board ELF:
#   python -I fw_defaults.py <board>.elf > fw57-defaults-<board>.txt
# One line per param, in table order: index sub type default (hex u32 wire value).
import struct, sys

elf = open(sys.argv[1], 'rb').read()
shoff, = struct.unpack_from('<I', elf, 0x20)
shentsize, shnum, shstrndx = struct.unpack_from('<HHH', elf, 0x2E)
secs = [struct.unpack_from('<IIIIIIIIII', elf, shoff + i * shentsize) for i in range(shnum)]
symtab = next(s for s in secs if s[1] == 2)
strtab = secs[symtab[6]]

def name(off, tab=strtab):
    end = elf.index(b'\0', tab[4] + off)
    return elf[tab[4] + off:end].decode()

def sym(n):
    for i in range(symtab[5] // 16):
        st_name, value, size, _, _, shndx = struct.unpack_from('<IIIBBH', elf, symtab[4] + i * 16)
        if name(st_name) == n:
            return value, size
    raise SystemExit(f'no symbol {n}')

def at(addr, size):
    for s in secs:
        if s[1] == 1 and s[3] <= addr < s[3] + s[5]:   # PROGBITS holding addr
            return elf[s[4] + addr - s[3]: s[4] + addr - s[3] + size]
    raise SystemExit(f'no section for {addr:#x}')

types = ['UInt8', 'Int8', 'UInt16', 'Int16', 'UInt32', 'Int32', 'Float', 'Bool', 'Enum']
addr, size = sym('stParams')
raw = at(addr, size)
for i in range(size // 24):   # sizeof(ParamInfo); NUM_PARAMS may be folded away
    index, sub, typ, _, _, default, _, _ = struct.unpack_from('<HBBIIIII', raw, i * 24)
    print(f'{index:04X} {sub} {types[typ]} {default:08X}')
