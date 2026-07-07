import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full border border-transparent px-3 text-sm font-medium whitespace-nowrap outline-none transition-[background,color,border-color,box-shadow,transform] active:scale-[0.98] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-none hover:bg-[color:var(--apple-blue-focus)]",
        destructive: "bg-destructive text-white shadow-none hover:bg-[#e0342b]",
        outline: "border-border bg-white/70 text-foreground shadow-none backdrop-blur-xl hover:border-[color:var(--apple-blue)] hover:bg-white hover:text-primary",
        secondary: "border-border bg-white/72 text-secondary-foreground shadow-none backdrop-blur-xl hover:bg-white",
        ghost: "text-[color:var(--apple-body)] hover:bg-white/62 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-11 px-6 text-[15px]",
        icon: "size-9 p-0"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
