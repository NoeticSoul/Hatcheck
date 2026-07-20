import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

type BadgeVariant = "default" | "secondary" | "muted" | "destructive" | "outline";

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-secondary text-secondary-foreground border border-border",
  muted: "bg-muted text-muted-foreground border border-border",
  destructive: "bg-destructive text-destructive-foreground",
  outline: "border border-border text-foreground",
};

export interface BadgeProps extends ComponentProps<"span"> {
  variant?: BadgeVariant;
}

export function Badge({
  className,
  variant = "default",
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
