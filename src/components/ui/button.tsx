import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer",
  {
    variants: {
      variant: {
        default: "bg-accent text-black hover:bg-[#ffb83d] shadow-[0_6px_24px_-8px_rgb(245_165_36/0.6)]",
        secondary: "bg-panel-3 text-fg border border-line-2 hover:bg-[#23232e] hover:border-[#3b3b4b]",
        ghost: "text-muted hover:text-fg hover:bg-panel-3",
        outline: "border border-line-2 text-fg hover:border-accent/60 hover:text-accent",
        danger: "bg-err/10 text-err border border-err/30 hover:bg-err/20",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 px-3 text-xs",
        xs: "h-6 px-2 text-[11px] rounded-md [&_svg]:size-3",
        lg: "h-11 px-6 text-base",
        icon: "size-9",
        "icon-sm": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = "Button";
