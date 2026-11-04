import { Navigate, Route, Routes } from "react-router";

import { SignedInLayout } from "@/components/signed-in-layout";
import { Toaster } from "@/components/ui/sonner";
import { useAuthState } from "@/lib/auth";
import { GroupPage } from "@/pages/group";
import { GroupsPage } from "@/pages/groups";
import { SignInPage } from "@/pages/sign-in";

export function App() {
	const auth = useAuthState();

	return (
		<>
			{auth.status === "loading" ? null : auth.status === "signed-out" ? (
				<SignInPage />
			) : (
				<Routes>
					<Route element={<SignedInLayout user={auth.user} />}>
						<Route index element={<GroupsPage />} />
						<Route path="groups/:groupId" element={<GroupPage />} />
						<Route path="*" element={<Navigate to="/" replace />} />
					</Route>
				</Routes>
			)}
			<Toaster position="top-center" />
		</>
	);
}
