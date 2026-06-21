use serde_json::{json, Value};

const MDMP: u32 = 0x504D444D;

const STREAM_THREAD_LIST: u32 = 3;
const STREAM_MODULE_LIST: u32 = 4;
const STREAM_EXCEPTION: u32 = 6;
const STREAM_SYSTEM_INFO: u32 = 7;
const STREAM_MISC_INFO: u32 = 15;

pub fn parse(b: &[u8]) -> Result<Value, String> {
    if b.len() < 32 {
        return Err("file too small to be a minidump".into());
    }
    let signature = u32(b, 0)?;
    if signature != MDMP {
        return Err(format!(
            "not a minidump (signature 0x{signature:08x}, expected 0x504d444d 'MDMP')"
        ));
    }
    let version = u32(b, 4)? & 0xffff;
    let n_streams = u32(b, 8)? as usize;
    let dir_rva = u32(b, 12)? as usize;
    let timestamp = u32(b, 20)?;

    if dir_rva + n_streams * 12 > b.len() {
        return Err("stream directory out of bounds".into());
    }

    let mut exception = Value::Null;
    let mut system_info = Value::Null;
    let mut modules: Vec<Value> = Vec::new();
    let mut threads: Vec<Value> = Vec::new();
    let mut misc = Value::Null;
    let mut stream_summary: Vec<(u32, u32)> = Vec::new();

    for i in 0..n_streams {
        let off = dir_rva + i * 12;
        let stream_type = u32(b, off)?;
        let data_size = u32(b, off + 4)?;
        let data_rva = u32(b, off + 8)? as usize;
        stream_summary.push((stream_type, data_size));
        if data_size == 0 || data_rva == 0 {
            continue;
        }
        let end = data_rva
            .checked_add(data_size as usize)
            .ok_or("stream length overflow")?;
        if end > b.len() {
            continue;
        }
        let slice = &b[data_rva..end];
        match stream_type {
            STREAM_EXCEPTION => exception = parse_exception(b, slice)?,
            STREAM_SYSTEM_INFO => system_info = parse_system_info(b, slice)?,
            STREAM_MODULE_LIST => modules = parse_module_list(b, slice)?,
            STREAM_THREAD_LIST => threads = parse_thread_list(slice)?,
            STREAM_MISC_INFO => misc = parse_misc_info(slice)?,
            _ => {}
        }
    }

    Ok(json!({
        "header": {
            "version": version,
            "number_of_streams": n_streams,
            "timestamp": timestamp,
            "size": b.len(),
        },
        "streams_present": stream_summary
            .iter()
            .map(|(t, s)| json!({"type": t, "type_name": stream_name(*t), "size": s}))
            .collect::<Vec<_>>(),
        "system_info": system_info,
        "exception": exception,
        "misc": misc,
        "modules": modules,
        "threads": threads,
    }))
}

fn parse_exception(b: &[u8], s: &[u8]) -> Result<Value, String> {
    if s.len() < 168 {
        return Err("exception stream truncated".into());
    }
    let thread_id = u32_(s, 0);
    let exception_code = u32_(s, 8);
    let exception_flags = u32_(s, 12);
    let exception_address = u64_(s, 24);
    let n_params = u32_(s, 32) as usize;
    let mut params = Vec::with_capacity(n_params.min(15));
    for i in 0..n_params.min(15) {
        params.push(format!("0x{:x}", u64_(s, 40 + i * 8)));
    }
    let thread_context_size = u32_(s, 160);
    let thread_context_rva = u32_(s, 164) as usize;
    let mut context = Value::Null;
    if thread_context_size as usize >= 0xF8 + 8
        && thread_context_rva + thread_context_size as usize <= b.len()
    {
        let c = &b[thread_context_rva..thread_context_rva + thread_context_size as usize];
        if c.len() >= 0x100 {
            context = json!({
                "rip": format!("0x{:016x}", u64_(c, 0xF8)),
                "rsp": format!("0x{:016x}", u64_(c, 0x98)),
                "rbp": format!("0x{:016x}", u64_(c, 0xA0)),
                "rcx": format!("0x{:016x}", u64_(c, 0x80)),
                "rdx": format!("0x{:016x}", u64_(c, 0x88)),
                "r8":  format!("0x{:016x}", u64_(c, 0xB8)),
                "r9":  format!("0x{:016x}", u64_(c, 0xC0)),
            });
        }
    }
    Ok(json!({
        "thread_id": thread_id,
        "exception_code": format!("0x{exception_code:08x}"),
        "exception_name": exception_code_name(exception_code),
        "exception_flags": format!("0x{exception_flags:08x}"),
        "exception_address": format!("0x{exception_address:016x}"),
        "parameters": params,
        "context": context,
    }))
}

fn parse_system_info(b: &[u8], s: &[u8]) -> Result<Value, String> {
    if s.len() < 24 {
        return Err("system info truncated".into());
    }
    let arch = u16_(s, 0);
    let level = u16_(s, 2);
    let revision = u16_(s, 4);
    let n_processors = s[6];
    let product_type = s[7];
    let major = u32_(s, 8);
    let minor = u32_(s, 12);
    let build = u32_(s, 16);
    let platform_id = u32_(s, 20);
    let csd_rva = if s.len() >= 28 { u32_(s, 24) as usize } else { 0 };
    let csd = if csd_rva > 0 {
        read_minidump_string(b, csd_rva).unwrap_or_default()
    } else {
        String::new()
    };
    Ok(json!({
        "architecture": arch_name(arch),
        "architecture_id": arch,
        "processor_level": level,
        "processor_revision": revision,
        "number_of_processors": n_processors,
        "product_type": product_type,
        "os_version": format!("{major}.{minor}.{build}"),
        "platform_id": platform_id,
        "csd_version": csd,
    }))
}

fn parse_module_list(b: &[u8], s: &[u8]) -> Result<Vec<Value>, String> {
    if s.len() < 4 {
        return Ok(Vec::new());
    }
    let n = u32_(s, 0) as usize;
    let mut out = Vec::with_capacity(n);
    let stride = 108;
    for i in 0..n {
        let off = 4 + i * stride;
        if off + stride > s.len() {
            break;
        }
        let base = u64_(s, off);
        let size = u32_(s, off + 8);
        let timestamp = u32_(s, off + 16);
        let name_rva = u32_(s, off + 20) as usize;
        let name = read_minidump_string(b, name_rva).unwrap_or_default();
        let short = name.rsplit(['/', '\\']).next().unwrap_or(&name).to_string();
        out.push(json!({
            "base_of_image": format!("0x{base:016x}"),
            "size_of_image": size,
            "timestamp": timestamp,
            "name": short,
            "path": name,
        }));
    }
    Ok(out)
}

fn parse_thread_list(s: &[u8]) -> Result<Vec<Value>, String> {
    if s.len() < 4 {
        return Ok(Vec::new());
    }
    let n = u32_(s, 0) as usize;
    let mut out = Vec::with_capacity(n);
    let stride = 48;
    for i in 0..n {
        let off = 4 + i * stride;
        if off + stride > s.len() {
            break;
        }
        let tid = u32_(s, off);
        let suspend = u32_(s, off + 4);
        let priority_class = u32_(s, off + 8);
        let priority = u32_(s, off + 12);
        let teb = u64_(s, off + 16);
        let stack_start = u64_(s, off + 24);
        let stack_size = u32_(s, off + 32);
        out.push(json!({
            "thread_id": tid,
            "suspend_count": suspend,
            "priority_class": priority_class,
            "priority": priority,
            "teb": format!("0x{teb:016x}"),
            "stack_start": format!("0x{stack_start:016x}"),
            "stack_size": stack_size,
        }));
    }
    Ok(out)
}

fn parse_misc_info(s: &[u8]) -> Result<Value, String> {
    if s.len() < 32 {
        return Ok(Value::Null);
    }
    let size = u32_(s, 0);
    let flags1 = u32_(s, 4);
    let process_id = u32_(s, 8);
    let create_time = u32_(s, 12);
    let user_time = u32_(s, 16);
    let kernel_time = u32_(s, 20);
    Ok(json!({
        "size": size,
        "flags1": format!("0x{flags1:08x}"),
        "process_id": process_id,
        "process_create_time": create_time,
        "process_user_time": user_time,
        "process_kernel_time": kernel_time,
    }))
}

fn read_minidump_string(b: &[u8], rva: usize) -> Option<String> {
    if rva + 4 > b.len() {
        return None;
    }
    let length = u32_(b, rva) as usize;
    let start = rva + 4;
    let end = start.checked_add(length)?;
    if end > b.len() {
        return None;
    }
    let u16_count = length / 2;
    let mut chars = Vec::with_capacity(u16_count);
    for i in 0..u16_count {
        let off = start + i * 2;
        chars.push(u16::from_le_bytes([b[off], b[off + 1]]));
    }
    Some(String::from_utf16_lossy(&chars))
}

fn u32(b: &[u8], off: usize) -> Result<u32, String> {
    b.get(off..off + 4)
        .map(|s| u32::from_le_bytes(s.try_into().unwrap()))
        .ok_or_else(|| format!("read u32 at 0x{off:x} out of bounds"))
}
fn u32_(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(b[off..off + 4].try_into().unwrap())
}
fn u64_(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(b[off..off + 8].try_into().unwrap())
}
fn u16_(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(b[off..off + 2].try_into().unwrap())
}

fn stream_name(t: u32) -> &'static str {
    match t {
        0 => "UnusedStream",
        1 => "ReservedStream0",
        2 => "ReservedStream1",
        3 => "ThreadListStream",
        4 => "ModuleListStream",
        5 => "MemoryListStream",
        6 => "ExceptionStream",
        7 => "SystemInfoStream",
        8 => "ThreadExListStream",
        9 => "Memory64ListStream",
        10 => "CommentStreamA",
        11 => "CommentStreamW",
        12 => "HandleDataStream",
        13 => "FunctionTableStream",
        14 => "UnloadedModuleListStream",
        15 => "MiscInfoStream",
        16 => "MemoryInfoListStream",
        17 => "ThreadInfoListStream",
        18 => "HandleOperationListStream",
        19 => "TokenStream",
        _ => "Unknown",
    }
}

fn arch_name(a: u16) -> &'static str {
    match a {
        0 => "X86",
        5 => "ARM",
        6 => "IA64",
        9 => "AMD64",
        12 => "ARM64",
        _ => "Unknown",
    }
}

fn exception_code_name(code: u32) -> &'static str {
    match code {
        0x80000003 => "BREAKPOINT",
        0x80000004 => "SINGLE_STEP",
        0xC0000005 => "ACCESS_VIOLATION",
        0xC0000006 => "IN_PAGE_ERROR",
        0xC000001D => "ILLEGAL_INSTRUCTION",
        0xC0000025 => "NONCONTINUABLE_EXCEPTION",
        0xC0000026 => "INVALID_DISPOSITION",
        0xC000008C => "ARRAY_BOUNDS_EXCEEDED",
        0xC000008D => "FLT_DENORMAL_OPERAND",
        0xC000008E => "FLT_DIVIDE_BY_ZERO",
        0xC000008F => "FLT_INEXACT_RESULT",
        0xC0000090 => "FLT_INVALID_OPERATION",
        0xC0000091 => "FLT_OVERFLOW",
        0xC0000092 => "FLT_STACK_CHECK",
        0xC0000093 => "FLT_UNDERFLOW",
        0xC0000094 => "INT_DIVIDE_BY_ZERO",
        0xC0000095 => "INT_OVERFLOW",
        0xC0000096 => "PRIV_INSTRUCTION",
        0xC00000FD => "STACK_OVERFLOW",
        0xC0000135 => "DLL_NOT_FOUND",
        0xC0000142 => "DLL_INIT_FAILED",
        0xC000013A => "CONTROL_C_EXIT",
        0xC0000194 => "POSSIBLE_DEADLOCK",
        0xC0000374 => "HEAP_CORRUPTION",
        0xC0000409 => "STACK_BUFFER_OVERRUN",
        0xC0000417 => "INVALID_CRUNTIME_PARAMETER",
        0xC0000420 => "ASSERTION_FAILURE",
        0xE06D7363 => "MSVC_CPP_EXCEPTION",
        _ => "UNKNOWN",
    }
}
