import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";

import { GroupFaces } from "@/components/group-faces";
import { SignedInLayout } from "@/components/signed-in-layout";
import { Toaster } from "@/components/ui/sonner";
import { useAuthState } from "@/lib/auth";
import { EntryPage } from "@/pages/entry";
import { GroupPage } from "@/pages/group";
import { GroupsPage } from "@/pages/groups";
import { JoinPage } from "@/pages/join";
import { SettingsPage } from "@/pages/settings";
import { SettleUpPage } from "@/pages/settle-up";
import { SignInPage } from "@/pages/sign-in";

// The design kit is for development only; production builds leave it out.
const KitPage = import.meta.env.DEV ? lazy(() => import("@/pages/kit").then((m) => ({ default: m.KitPage }))) : null;

export function App() {
	const auth = useAuthState();
	const { pathname } = useLocation();

	if (KitPage && pathname === "/kit") {
		return (
			<Suspense>
				<KitPage />
			</Suspense>
		);
	}

	return (
		<>
			{auth.status === "loading" ? null : auth.status === "signed-out" ? (
				<Routes>
					<Route path="join/:code" element={<JoinPage signedIn={false} />} />
					<Route path="*" element={<SignInPage />} />
				</Routes>
			) : (
				<Routes>
					<Route element={<SignedInLayout user={auth.user} />}>
						<Route index element={<GroupsPage />} />
						<Route path="join/:code" element={<JoinPage signedIn />} />
						<Route path="settings" element={<SettingsPage />} />
						<Route path="groups/:groupId" element={<GroupFaces />}>
							<Route index element={<GroupPage />} />
							<Route path="entries/:entryId" element={<EntryPage />} />
							<Route path="settle" element={<SettleUpPage />} />
						</Route>
						<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
				</Routes>
			)}
			<Toaster position="top-center" />
		</>
	);
}
