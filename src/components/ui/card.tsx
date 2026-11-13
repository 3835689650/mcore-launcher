import * as React from 'react';
import { cn } from '../../lib/utils';

/** 卡片：玻璃开启时半透明模糊，关闭时纯色（由全局 CSS 变量切换） */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('mc-panel rounded-lg border border-zinc-200 p-6 shadow-none dark:border-zinc-700', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn('text-xl font-semibold md:text-2xl', className)} {...props} />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm text-zinc-500 dark:text-zinc-400', className)} {...props} />
  ),
);
CardDescription.displayName = 'CardDescription';

export { Card, CardTitle, CardDescription };
