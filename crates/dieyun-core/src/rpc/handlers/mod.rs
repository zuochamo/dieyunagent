//! 闃诲鍨?RPC 鐨?handler锛?*姣忎釜鏂规硶涓€涓嚱鏁?*銆?//!
//! 涓轰粈涔堟媶鍑烘潵锛歚rpc/mod.rs` 閲岀殑 `match` 鏇剧粡鍚屾椂鏄€屾湁鍝簺鏂规硶銆嶃€岃皝闃诲銆嶃€岃皝鐨勯绠椼€?//! 涓変唤鐭ヨ瘑鐨勮浇浣?鈥斺€?鍏ㄩ潬"鍐欏湪鍝紶 match 閲?琛ㄨ揪锛屽姞涓€涓柟娉曡鏀逛笁澶勶紝鏀归敊浠讳綍涓€澶勯兘
//! 涓嶄細璁╂祴璇曞彉绾€傛柟娉曡〃锛圼`crate::rpc::registry`]锛夋妸鍚嶅瓧 / 璺敱 / 棰勭畻鏀惰蛋涔嬪悗锛屽嚱鏁颁綋
//! 鎸夊煙鎼埌杩欓噷锛?//!
//! - 鎼竴涓柟娉?= **鏀硅〃涓€琛?*锛堝姞 `blocking: Some(handler)`锛? **鍐欎竴涓?`fn`** + **鍒犳帀鍘熸潵鐨勮噦**锛?//! - `registry.rs` 鐨?parity 娴嬭瘯淇濊瘉涓嶄細鍑虹幇銆岃〃閲屾湁銆佸疄鐜版病鏈夈€嶃€屽疄鐜版湁銆佽〃閲屾病鏈夈€?//!   銆屾棦鏈?handler 鍙堟湁鑷備綋锛堝弻浠藉疄鐜帮級銆嶏紱
//! - 姣忎釜 handler 閮芥槸 `fn(&ServiceSnapshot, &Value)`锛氭棤 `.await`銆佹棤鍏ㄥ眬鐘舵€侊紝
//!   鍥犳鍙互琚崟娴嬬洿鎺ヨ皟鐢紝涔熷ぉ鐢熺寰楀紑 async worker銆?
pub mod agent;
pub mod async_core;
pub mod async_data;
pub mod codebase;
pub mod memory;
pub mod fs;
pub mod graph;
pub mod system;
