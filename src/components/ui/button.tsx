import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Unified with the redesign's pill / warm-gradient button language so old
// shadcn buttons and redesign "solid-button" / "ghost-button" surfaces visually
// match. Base radius is rounded-full; icon size stays a perfect circle.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-bold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "text-white shadow-[0_14px_30px_rgba(58,50,71,0.20)] bg-[linear-gradient(135deg,#2b2436_0%,#7b5244_55%,#8b5e4a_100%)] hover:-translate-y-0.5 hover:shadow-[0_18px_36px_rgba(58,50,71,0.26)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_12px_26px_rgba(164,93,98,0.22)] hover:bg-destructive/90",
        outline:
          "border border-border bg-card text-foreground shadow-sm hover:bg-muted active:bg-muted/70",
        secondary:
          "bg-muted text-foreground hover:bg-muted/80",
        ghost:
          "text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted/70",
        link: "rounded-none text-accent underline-offset-4 hover:underline",
        // Translucent glass surface — for buttons sitting on photos / dark
        // overlays / sticky-translucent chrome, where a solid token fill would
        // look heavy. This is the OLD `outline` look, kept as an opt-in so the
        // default outline can be contrast-safe on white panels.
        glass:
          "border border-white/70 bg-white/55 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] backdrop-blur-md hover:bg-white/75",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3.5",
        lg: "h-12 px-7 text-[15px]",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
