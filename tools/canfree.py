#!/usr/bin/env python3
"""
canfree - find free CAN IDs and collision-free base addresses.

Reads a DBC file or a CAN log, reports which arbitration IDs are in use, lists the free
contiguous ranges in the 11-bit standard space (0x000-0x7FF), and (with --fit / --device /
--preset) proposes base addresses for new devices that land entirely in free space.

Single file, stdlib only. Uses `cantools` (DBC) and `python-can` (logs) if installed,
otherwise falls back to built-in parsers. Degrades gracefully either way.

Examples:
    canfree bus.dbc
    canfree candump.log --min 16
    canfree bus.dbc --fit --device Front:29 --device Rear:11 --group
    canfree bus.dbc --preset dingo:5pdm,2cb
    canfree --selftest
"""
import argparse
import os
import re
import sys

STD_MAX = 0x7FF       # 11-bit standard arbitration space (0x000-0x7FF)
EXT_MAX = 0x1FFFFFFF  # 29-bit extended arbitration space
EXT_FLAG = 0x80000000  # DBC sets bit 31 on extended message IDs

# OBD-II / UDS diagnostic IDs - reserved even when not observed, unless --no-reserve.
OBD_RESERVED = {0x7DF, 0x7F1} | set(range(0x7E0, 0x7EF + 1))


# --------------------------------------------------------------------------- DBC
def parse_dbc_text(text):
    """(std_ids, ext_ids) from DBC text via regex on `BO_ <id> <name>: <dlc> <tx>` lines."""
    std, ext = set(), set()
    for m in re.finditer(r'^\s*BO_\s+(\d+)\s+\S+\s*:\s*\d+\s+\S+', text, re.M):
        raw = int(m.group(1))
        if raw & EXT_FLAG:
            ext.add(raw & EXT_MAX)            # bit 31 set => extended; mask to 29 bits
        else:
            std.add(raw & EXT_MAX)
    return std, ext


def collect_from_dbc(path):
    """Prefer cantools; fall back to regex on any failure."""
    try:
        import cantools
        db = cantools.database.load_file(path)
        std, ext = set(), set()
        for msg in db.messages:
            if getattr(msg, 'is_extended_frame', False):
                ext.add(msg.frame_id & EXT_MAX)
            else:
                std.add(msg.frame_id & EXT_MAX)
        return std, ext, 'cantools'
    except ImportError:
        pass
    except Exception as e:  # malformed file, version skew, ...
        sys.stderr.write(f"cantools failed ({e}); using regex fallback.\n")
    with open(path, encoding='utf-8', errors='replace') as f:
        std, ext = parse_dbc_text(f.read())
    return std, ext, 'regex'


# --------------------------------------------------------------------------- LOG
def parse_candump(line):
    """SocketCAN candump: '(ts) iface ID#DATA' or 'iface ID#DATA'. ID hex; >3 nybbles => ext."""
    m = re.search(r'(?:\(\s*[\d.]+\s*\)\s+)?\S+\s+([0-9A-Fa-f]{1,8})#', line)
    if not m:
        return None
    idhex = m.group(1)
    idv = int(idhex, 16)
    return (idv & EXT_MAX, True) if len(idhex) > 3 else (idv, False)


def parse_asc(line):
    """Vector ASC: 'ts chan ID[x] dir d dlc ...'. Trailing 'x' on the ID marks extended."""
    p = line.split()
    if len(p) < 4 or p[3] not in ('Rx', 'Tx'):
        return None
    try:
        float(p[0])
    except ValueError:
        return None
    tok = p[2]
    isext = tok[-1:] in ('x', 'X')
    try:
        idv = int(tok.rstrip('xX'), 16)
    except ValueError:
        return None
    return (idv & EXT_MAX, True) if isext else (idv, False)


def _parse_int(v):
    """Parse a CSV ID cell: 0x-prefixed or hex-with-letters => hex, plain digits => decimal."""
    v = (v or '').strip()
    if not v:
        return None
    try:
        if v.lower().startswith('0x'):
            return int(v, 16)
        if re.fullmatch(r'[0-9A-Fa-f]+', v) and re.search(r'[A-Fa-f]', v):
            return int(v, 16)
        return int(v, 10)
    except ValueError:
        try:
            return int(v, 16)
        except ValueError:
            return None


def parse_csv(lines):
    """CSV with an ID column (and optional extended/ide column)."""
    import csv
    std, ext = set(), set()
    rows = list(csv.reader(lines))
    if not rows:
        return std, ext
    header = [h.strip().lower() for h in rows[0]]

    def col(*names):
        for i, h in enumerate(header):
            if h in names:
                return i
        return None

    idcol = col('id', 'can_id', 'canid', 'arbitration_id', 'arbitrationid', 'identifier')
    if idcol is None:
        idcol = next((i for i, h in enumerate(header) if 'id' in h), None)
    if idcol is None:
        return std, ext
    extcol = col('extended', 'ext', 'ide', 'is_extended', 'is_extended_id')
    for row in rows[1:]:
        if len(row) <= idcol:
            continue
        idv = _parse_int(row[idcol])
        if idv is None:
            continue
        if extcol is not None and len(row) > extcol:
            isext = row[extcol].strip().lower() in ('1', 'true', 'yes', 'x', 'extended', 'ext')
        else:
            isext = idv > STD_MAX
        (ext.add(idv & EXT_MAX) if isext else std.add(idv))
    return std, ext


def collect_from_log(path):
    """Prefer python-can readers; fall back to CSV/candump/ASC line parsing."""
    try:
        import can
        std, ext = set(), set()
        with can.LogReader(path) as reader:
            for msg in reader:
                if msg.is_extended_id:
                    ext.add(msg.arbitration_id & EXT_MAX)
                else:
                    std.add(msg.arbitration_id)
        return std, ext, 'python-can'
    except ImportError:
        pass
    except Exception as e:
        sys.stderr.write(f"python-can failed ({e}); using text parser.\n")
    with open(path, encoding='utf-8', errors='replace') as f:
        lines = f.readlines()
    if lines and ',' in lines[0] and 'id' in lines[0].lower():
        std, ext = parse_csv(lines)
        return std, ext, 'csv'
    std, ext = set(), set()
    for ln in lines:
        r = parse_candump(ln) or parse_asc(ln)
        if r:
            (ext.add(r[0]) if r[1] else std.add(r[0]))
    return std, ext, 'lines'


def collect(path):
    """Auto-detect DBC vs CAN log by extension, then by content."""
    suffix = os.path.splitext(path)[1].lower()
    if suffix == '.dbc':
        return collect_from_dbc(path)
    if suffix in ('.asc', '.log', '.csv', '.trc', '.txt'):
        return collect_from_log(path)
    with open(path, encoding='utf-8', errors='replace') as f:
        head = f.read(4096)
    if re.search(r'^\s*BO_\s+\d+', head, re.M):
        return collect_from_dbc(path)
    return collect_from_log(path)


# ----------------------------------------------------------------------- ranges
def free_ranges(used, lo, hi, minlen):
    """Contiguous [a, b] runs in [lo, hi] with no used ID, each at least minlen wide.
    Gap-based so it works across the full 29-bit space without iterating it."""
    out = []
    cur = lo
    for u in sorted(x for x in used if lo <= x <= hi):
        if u - cur >= minlen:
            out.append((cur, u - 1))
        cur = max(cur, u + 1)
    if hi - cur + 1 >= minlen:
        out.append((cur, hi))
    return out


def next_pow2(n):
    """Smallest power of two >= n (>= 1)."""
    return 1 << max(0, (n - 1).bit_length())


def span_is_free(base, span, used):
    return all((base + i) not in used for i in range(span))


# -------------------------------------------------------------------- allocator
def fit_group(devices, used, lo=0, hi=STD_MAX):
    """Pack every device into ONE contiguous free window, each at its spacing stride.
    Returns (window_lo, window_hi, [(device, base), ...]) or (None, None, None)."""
    total = sum(d['spacing'] for d in devices)
    if total == 0:
        return None, None, None
    w = lo
    while w + total - 1 <= hi:
        if span_is_free(w, total, used):
            bases, cur = [], w
            for d in devices:
                bases.append((d, cur))
                cur += d['spacing']
            return w, w + total - 1, bases
        w += 1
    return None, None, None


def fit_each(devices, used, lo=0, hi=STD_MAX):
    """Place each device at the lowest free base independently. Returns [(device, base|None)]."""
    work = set(used)
    rows = []
    for d in devices:
        base, w = None, lo
        while w + d['span'] - 1 <= hi:
            if span_is_free(w, d['span'], work):
                base = w
                break
            w += 1
        rows.append((d, base))
        if base is not None:
            for i in range(d['span']):
                work.add(base + i)
    return rows


def parse_device(spec):
    """NAME:SPAN[:SPACING] -> device dict. SPACING defaults to next pow2 >= SPAN."""
    parts = spec.split(':')
    if len(parts) < 2 or not parts[1].strip():
        raise ValueError(f"bad --device {spec!r} (want NAME:SPAN[:SPACING])")
    name = parts[0]
    span = int(parts[1], 0)
    spacing = int(parts[2], 0) if len(parts) > 2 and parts[2].strip() else next_pow2(span)
    return {'name': name, 'span': span, 'spacing': spacing}


# dingoPDM owns base..base+28 (29 cyclic+config IDs); CANBoard owns base..base+13 (14):
# +0/+1 config, +2..+11 cyclic, +12/+13 OpenBLT XCP bootloader command/response.
PRESET_KINDS = {
    'pdm': ('dingoPDM', 29, 32), 'dingopdm': ('dingoPDM', 29, 32),
    'cb': ('CANBoard', 14, 16), 'canboard': ('CANBoard', 14, 16),
}


def parse_preset(spec):
    """e.g. 'dingo:5pdm,2cb' -> [dingoPDM x5, CANBoard x2] as a group."""
    body = spec.split(':', 1)[1] if ':' in spec else spec
    devices = []
    for tok in body.split(','):
        m = re.fullmatch(r'\s*(\d+)\s*([A-Za-z]+)\s*', tok)
        if not m:
            raise ValueError(f"bad preset token {tok!r}")
        count, kind = int(m.group(1)), m.group(2).lower()
        if kind not in PRESET_KINDS:
            raise ValueError(f"unknown preset device {kind!r} (known: {sorted(PRESET_KINDS)})")
        label, span, spacing = PRESET_KINDS[kind]
        for i in range(count):
            devices.append({'name': f'{label}-{i + 1}', 'span': span, 'spacing': spacing})
    return devices


# ------------------------------------------------------------------------ output
def _h(idv, ext=False):
    return f"0x{idv:08X}" if ext else f"0x{idv:03X}"


def _print_ranges(title, ranges, ext=False):
    print(title)
    if not ranges:
        print("  (none)")
        return
    for a, b in ranges:
        print(f"  {_h(a, ext)}-{_h(b, ext)} ({b - a + 1} IDs)")


def _print_allocation(rows, used, window=None):
    if window:
        print(f"\nAllocation (group window {_h(window[0])}-{_h(window[1])}, "
              f"{window[1] - window[0] + 1} IDs):")
    else:
        print("\nAllocation:")
    name_w = max((len(d['name']) for d, _ in rows), default=4)
    all_clear = True
    for d, base in rows:
        if base is None:
            all_clear = False
            print(f"  {d['name']:<{name_w}}  (no free window for span {d['span']})  NO FIT")
            continue
        clear = span_is_free(base, d['span'], used)
        all_clear = all_clear and clear
        status = 'CLEAR' if clear else 'COLLIDES'
        print(f"  {d['name']:<{name_w}}  base {_h(base)}  "
              f"span {_h(base)}-{_h(base + d['span'] - 1)} ({d['span']})  {status}")
    return all_clear


# -------------------------------------------------------------------------- main
def run_report(args):
    std, ext, source = collect(args.file)
    reserved = set() if args.no_reserve else set(OBD_RESERVED)
    std_used = std | reserved

    print(f"canfree - {args.file}  (parser: {source})")
    sline = f"{len(std)} standard"
    if std:
        sline += f" ({_h(min(std))}-{_h(max(std))})"
    eline = f"{len(ext)} extended"
    if ext:
        eline += f" ({_h(min(ext), True)}-{_h(max(ext), True)})"
    print(f"Used IDs: {sline}, {eline}")
    if reserved:
        print("Reserved: OBD-II diagnostic IDs (0x7DF, 0x7E0-0x7EF, 0x7F1) - treated as used")
    print()

    _print_ranges(f"Free standard ranges (>= {args.min} IDs):",
                  free_ranges(std_used, 0, STD_MAX, args.min))
    if args.ext:
        print()
        _print_ranges(f"Free extended ranges (>= {args.min} IDs):",
                      free_ranges(ext, 0, EXT_MAX, args.min), ext=True)

    devices = None
    grouped = args.group
    if args.preset:
        devices = parse_preset(args.preset)
        grouped = True  # preset always allocates the fleet as one group
    elif args.device:
        devices = [parse_device(s) for s in args.device]
    elif args.fit:
        print("\n--fit needs --device or --preset to know what to place.", file=sys.stderr)

    if devices:
        if grouped:
            lo, hi, bases = fit_group(devices, std_used)
            if bases is None:
                print(f"\nAllocation: no single free window fits "
                      f"{sum(d['spacing'] for d in devices)} contiguous IDs.")
                return 1
            _print_allocation(bases, std_used, window=(lo, hi))
        else:
            _print_allocation(fit_each(devices, std_used), std_used)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog='canfree',
                                 description='Find free CAN IDs and collision-free base addresses.')
    ap.add_argument('file', nargs='?', help='DBC (.dbc) or CAN log (candump / .asc / .csv)')
    ap.add_argument('--ext', action='store_true', help='also report 29-bit extended space')
    ap.add_argument('--min', type=int, default=8, help='minimum free-range size to list (default 8)')
    ap.add_argument('--fit', action='store_true', help='propose base addresses (with --device)')
    ap.add_argument('--device', action='append', default=[], metavar='NAME:SPAN[:SPACING]',
                    help='device to place (repeatable)')
    ap.add_argument('--group', action='store_true', help='pack all --device into one window')
    ap.add_argument('--preset', metavar='dingo:5pdm,2cb', help='preset fleet (implies --group)')
    ap.add_argument('--no-reserve', action='store_true', help="don't reserve OBD-II diagnostic IDs")
    ap.add_argument('--selftest', action='store_true', help='run the built-in self-test and exit')
    args = ap.parse_args(argv)

    if args.selftest:
        selftest()
        return 0
    if not args.file:
        ap.error('a DBC or CAN-log file is required (or use --selftest)')
    if not os.path.exists(args.file):
        ap.error(f'no such file: {args.file}')
    return run_report(args)


# -------------------------------------------------------------------- self-test
def selftest():
    # Tiny synthetic DBC: standard IDs 0x100, 0x200, 0x400, with known gaps around them.
    dbc = (
        "BO_ 256 EngineData: 8 ECU\n"      # 0x100
        "BO_ 512 BrakeData: 8 ABS\n"       # 0x200
        "BO_ 1024 BodyData: 8 BCM\n"       # 0x400
    )
    std, ext = parse_dbc_text(dbc)
    assert std == {0x100, 0x200, 0x400}, std
    assert ext == set(), ext

    # An extended-flagged ID is masked and classified as extended.
    es, ee = parse_dbc_text(f"BO_ {0x80000000 | 0x18DAF110} X: 8 T\n")
    assert es == set() and ee == {0x18DAF110}, (es, ee)

    # Free ranges (default reserve on) land in the gaps between the three IDs.
    used = std | OBD_RESERVED
    fr = free_ranges(used, 0, STD_MAX, 8)
    for expect in [(0x000, 0x0FF), (0x101, 0x1FF), (0x201, 0x3FF)]:
        assert expect in fr, (expect, fr)
    # OBD block is excluded from the free list.
    assert all(not (a <= 0x7E0 <= b) for a, b in fr), fr

    # next_pow2 / spacing
    assert (next_pow2(29), next_pow2(11), next_pow2(8), next_pow2(1)) == (32, 16, 8, 1)

    # ACCEPTANCE: preset dingo:5pdm,2cb -> all 7 spans CLEAR in one contiguous window.
    devices = parse_preset('dingo:5pdm,2cb')
    assert len(devices) == 7, len(devices)
    lo, hi, bases = fit_group(devices, used)
    assert bases is not None, 'no window found'
    assert len(bases) == 7
    assert hi - lo + 1 == sum(d['spacing'] for d in devices)  # one packed window
    for d, base in bases:
        assert lo <= base and base + d['span'] - 1 <= hi, (d['name'], _h(base))
        assert span_is_free(base, d['span'], used), f"{d['name']} @ {_h(base)} collides"

    # No-fit case: a span larger than the largest free window reports NO FIT.
    crammed = set(range(0, STD_MAX + 1)) - {0x10, 0x11, 0x12}
    rows = fit_each([{'name': 'big', 'span': 8, 'spacing': 8}], crammed)
    assert rows[0][1] is None, rows

    print("selftest OK - 7/7 preset spans CLEAR in window "
          f"{_h(lo)}-{_h(hi)}; DBC gaps and ext masking verified.")


if __name__ == '__main__':
    sys.exit(main())
