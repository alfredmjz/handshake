import { supabase } from "@/lib/supabase";
import type { SyncTransport } from "@/lib/sync/engine";
import type { PushResult } from "@/lib/sync/types";
import { toPullResult, type RawPull } from "@/lib/sync/wire";

// The only place the app talks to the server about data. Moving off Supabase means replacing this file
// and the two SQL functions it calls.
export const supabaseTransport: SyncTransport = {
	async push(mutations) {
		const { data, error } = await supabase.rpc("push_changes", { p_mutations: mutations });
		if (error) throw new Error(error.message);
		return data as PushResult;
	},
	async pull(cursors) {
		const { data, error } = await supabase.rpc("pull_changes", { p_cursors: cursors });
		if (error) throw new Error(error.message);
		return toPullResult(data as RawPull);
	},
};
