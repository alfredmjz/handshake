import { useCallback } from "react";

import { showRefusal } from "@/components/signed-in-layout";
import { useCommit, type Intent, type Plan } from "@/lib/changes";

// commit(intent), showing the refusal toast when the plan is refused. Resolves to the plan.
export function useRun() {
	const commit = useCommit();
	return useCallback(
		async (intent: Intent): Promise<Plan> => {
			const plan = await commit(intent);
			if (!plan.ok) showRefusal(plan.code, plan.reason);
			return plan;
		},
		[commit]
	);
}
