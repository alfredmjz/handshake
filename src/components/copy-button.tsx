import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export async function copyText(text: string, done: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(done);
	} catch {
		toast.error("Couldn't copy");
	}
}

// An icon button that copies text: label names what it copies ("Copy code"), done is the toast.
export function CopyButton({
	text,
	label,
	done,
	disabled,
}: {
	text: string;
	label: string;
	done: string;
	disabled?: boolean;
}) {
	return (
		<Button
			size="icon-sm"
			variant="ghost"
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={() => void copyText(text, done)}
		>
			<Copy />
		</Button>
	);
}
