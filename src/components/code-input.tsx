import { useState, type ChangeEvent, type ClipboardEvent } from "react";
import { ClipboardPaste } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { canPaste, emailedCodeIn, readClipboard, useEmailedCodeFromClipboard } from "@/lib/emailed-code";

const LENGTH = 6;

type CodeInputProps = {
	id: string;
	value: string;
	onChange: (code: string) => void;
	// Called once the sixth digit is in, however it got there: typed, pasted, filled in by the phone, or taken from
	// the clipboard on coming back to the app.
	onComplete: (code: string) => void;
	// False while the code is being checked or can't be: no taking it from the clipboard then.
	ready?: boolean;
	autoFocus?: boolean;
};

// The 6-digit code from an email, with a Paste button for browsers that read the clipboard only after a tap.
export function CodeInput({ id, value, onChange, onComplete, ready = true, autoFocus }: CodeInputProps) {
	const [pasteShown] = useState(canPaste);

	function take(next: string) {
		onChange(next);
		if (next.length === LENGTH && ready) onComplete(next);
	}

	useEmailedCodeFromClipboard(ready, take);

	function typed(event: ChangeEvent<HTMLInputElement>) {
		const raw = event.target.value;
		const next = (raw.length > LENGTH && emailedCodeIn(raw)) || raw.replace(/\D/g, "").slice(0, LENGTH);
		if (next.length === LENGTH && value.length < LENGTH) take(next);
		else onChange(next);
	}

	function pasted(event: ClipboardEvent<HTMLInputElement>) {
		const code = emailedCodeIn(event.clipboardData.getData("text"));
		if (!code) return;
		event.preventDefault();
		take(code);
	}

	async function paste() {
		let text: string;
		try {
			text = await readClipboard(true);
		} catch {
			toast.error("Couldn't paste", { description: "Paste it into the box instead." });
			return;
		}
		const code = emailedCodeIn(text);
		if (code) take(code);
		else toast.error("No code to paste", { description: "Copy the 6 digits from the email first." });
	}

	return (
		<div className="relative">
			<Input
				id={id}
				variant="code"
				className={pasteShown ? "px-12" : undefined}
				inputMode="numeric"
				autoComplete="one-time-code"
				placeholder="000000"
				required
				autoFocus={autoFocus}
				value={value}
				onChange={typed}
				onPaste={pasted}
			/>
			{pasteShown && (
				<Button
					type="button"
					size="icon-sm"
					variant="ghost"
					className="absolute right-2 top-1/2 -translate-y-1/2"
					aria-label="Paste code"
					title="Paste code"
					disabled={!ready}
					onClick={() => void paste()}
				>
					<ClipboardPaste />
				</Button>
			)}
		</div>
	);
}
