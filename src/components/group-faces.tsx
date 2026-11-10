import { Outlet, useParams } from "react-router";

import { FaceSlots } from "@/components/art/face";
import { useMembers } from "@/lib/members";

// Wraps a group's screens so its people get distinct faces, editors and dialogs included.
export function GroupFaces() {
	const { groupId } = useParams();
	const members = useMembers(groupId ?? "", { includeLeft: true });
	return (
		<FaceSlots members={members}>
			<Outlet />
		</FaceSlots>
	);
}
