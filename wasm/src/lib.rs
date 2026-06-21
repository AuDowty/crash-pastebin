use wasm_bindgen::prelude::*;

mod minidump;

#[wasm_bindgen]
pub fn parse_minidump(bytes: &[u8]) -> Result<String, JsValue> {
    let parsed = minidump::parse(bytes).map_err(|e| JsValue::from_str(&e))?;
    Ok(parsed.to_string())
}
