import * as React from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type FieldProps = {
	label: React.ReactNode;
	htmlFor?: string;
	hint?: React.ReactNode;
	error?: React.ReactNode;
	className?: string;
	children: React.ReactNode;
};

// A label over its control, with one line of help or the problem under it.
function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
	return (
		<div className={cn("flex flex-col gap-1", className)}>
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
			{error ? (
				<p role="alert" className="type-label text-owe">
					{error}
				</p>
			) : (
				hint && <p className="type-label text-muted-foreground">{hint}</p>
			)}
		</div>
	);
}

// A group of chips or choices with a legend instead of a label.
function FieldSet({
	legend,
	className,
	children,
}: {
	legend: React.ReactNode;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<fieldset className={cn("m-0 flex min-w-0 flex-col gap-control border-0 p-0", className)}>
			<legend className="type-label mb-control p-0 text-muted-foreground">{legend}</legend>
			{children}
		</fieldset>
	);
}

export { Field, FieldSet };
