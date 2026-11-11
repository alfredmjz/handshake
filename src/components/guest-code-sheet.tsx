import { useLocation, useNavigate } from "react-router";

import { copyText } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { formatCode } from "@/lib/code-format";
import { useMyGuestCode } from "@/lib/codes";

// Navigation state the join screen sets after someone joins as a guest.
export type GuestCodeSheetState = { showGuestCode: true };

// Once, right after a guest joins: their personal code, as soon as it has synced.
export function GuestCodeSheet({ groupId }: { groupId: string }) {
	const location = useLocation();
	const navigate = useNavigate();
	const code = useMyGuestCode(groupId);
	const wanted = (location.state as GuestCodeSheetState | null)?.showGuestCode === true;
	if (!wanted || !code) return null;

	const close = () => navigate(`${location.pathname}${location.search}`, { replace: true, state: null });

	return (
		<Dialog open onOpenChange={(open) => !open && close()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Your code is {formatCode(code)}</DialogTitle>
					<DialogDescription>Save it to get back in on another device.</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button size="lg" onClick={() => void copyText(formatCode(code), "Code copied")}>
						Copy
					</Button>
					<Button size="lg" variant="ghost" onClick={close}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
