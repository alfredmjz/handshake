import { useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { joinPath, normaliseCode } from "@/lib/code-format";
import { cn } from "@/lib/utils";

// A group code ("HX7-K2P"), a guest's personal code ("7KQM-2DXH"), any case, with or without the dash, or a
// pasted /join/ link; opens the join screen, which tells them apart.
export function JoinCodeForm({
	className,
	autoFocus,
	children,
}: {
	className?: string;
	autoFocus?: boolean;
	// More buttons under Open (the welcome sheet's Back).
	children?: ReactNode;
}) {
	const navigate = useNavigate();
	const [text, setText] = useState("");
	const [error, setError] = useState(false);

	function open(event: FormEvent) {
		event.preventDefault();
		const code = normaliseCode(text);
		if (code) navigate(joinPath(code));
		else setError(true);
	}

	return (
		<form onSubmit={open} className={cn("flex flex-col gap-stack", className)}>
			<div className="flex items-end gap-control">
				<Field
					label="Group or personal code"
					htmlFor="join-code"
					className="flex-1"
					error={error ? "That doesn't look like a code" : undefined}
				>
					<Input
						id="join-code"
						placeholder="HX7-K2P or a link"
						autoCapitalize="characters"
						autoComplete="off"
						spellCheck={false}
						autoFocus={autoFocus}
						value={text}
						onChange={(e) => {
							setText(e.target.value);
							setError(false);
						}}
					/>
				</Field>
				<Button type="submit" disabled={!text.trim()}>
					Open
				</Button>
			</div>
			{children}
		</form>
	);
}
