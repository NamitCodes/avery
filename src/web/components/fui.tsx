/**
 * Thin adapters over @rtcamp/frappe-ui-react (the React port of Frappe UI) so
 * pages can use Frappe components with the app's conventions:
 * - inputs accept normal HTML attributes (id, name, autoComplete, minLength…),
 * - selects accept <option> children,
 * - link-styled buttons share Frappe's exact button classes.
 */
import {
  Badge,
  Breadcrumbs,
  Button as FrappeButton,
  Select as FrappeSelect,
  TextInput,
  Textarea as FrappeTextarea,
  type ButtonProps,
} from '@rtcamp/frappe-ui-react';
import {
  Children,
  forwardRef,
  isValidElement,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useNavigate } from 'react-router-dom';

export { Avatar, Badge, Card, Dialog, Spinner, Tooltip } from '@rtcamp/frappe-ui-react';

type Theme = 'gray' | 'blue' | 'green' | 'red';
type Variant = 'solid' | 'subtle' | 'outline' | 'ghost';
type Size = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/** Frappe Button with the app's default: medium size, subtle gray. */
/** Hover/press for white secondary buttons (Frappe's outline variant has no background hover). */
const WHITE_HOVER = 'hover:bg-surface-gray-1 active:bg-surface-gray-2';

/**
 * Frappe Button with the app's defaults: medium size; secondary (gray "subtle")
 * buttons are rendered white with a border (Frappe's outline variant) and a soft hover.
 */
export function Button({ size = 'md', variant = 'subtle', theme = 'gray', className, ...props }: ButtonProps) {
  const white = theme === 'gray' && variant === 'subtle';
  return (
    <FrappeButton
      size={size}
      theme={theme}
      variant={white ? 'outline' : variant}
      className={[white && !props.disabled && !props.loading ? WHITE_HOVER : '', className ?? ''].join(' ').trim() || undefined}
      {...props}
    />
  );
}

/** Frappe UI button classes, for links and other elements that must look like buttons. */
export function buttonClass({ theme = 'gray', variant = 'subtle', size = 'md' }: { theme?: Theme; variant?: Variant; size?: Size } = {}) {
  const variants: Record<Variant, Record<Theme, string>> = {
    solid: {
      gray: 'text-ink-white bg-surface-gray-7 hover:bg-surface-gray-6 active:bg-surface-gray-5',
      blue: 'text-ink-white bg-blue-500 hover:bg-surface-blue-3 active:bg-blue-700',
      green: 'text-ink-white bg-surface-green-3 hover:bg-green-700 active:bg-green-800',
      red: 'text-ink-white bg-surface-red-5 hover:bg-surface-red-6 active:bg-surface-red-7',
    },
    subtle: {
      // White secondary button (matches Button above).
      gray: 'text-ink-gray-8 bg-surface-white border border-outline-gray-2 hover:bg-surface-gray-1 hover:border-outline-gray-3 active:bg-surface-gray-2',
      blue: 'text-ink-blue-3 bg-surface-blue-2 hover:bg-blue-200 active:bg-blue-300',
      green: 'text-green-800 bg-surface-green-2 hover:bg-green-200 active:bg-green-300',
      red: 'text-red-700 bg-surface-red-2 hover:bg-surface-red-3 active:bg-surface-red-4',
    },
    outline: {
      gray: 'text-ink-gray-8 bg-surface-white border border-outline-gray-2 hover:border-outline-gray-3',
      blue: 'text-ink-blue-3 bg-surface-white border border-outline-blue-1 hover:border-blue-400',
      green: 'text-green-800 bg-surface-white border border-outline-green-2 hover:border-green-500',
      red: 'text-red-700 bg-surface-white border border-outline-red-1 hover:border-outline-red-2',
    },
    ghost: {
      gray: 'text-ink-gray-8 bg-transparent hover:bg-surface-gray-3 active:bg-surface-gray-4',
      blue: 'text-ink-blue-3 bg-transparent hover:bg-blue-200 active:bg-blue-300',
      green: 'text-green-800 bg-transparent hover:bg-green-200 active:bg-green-300',
      red: 'text-red-700 bg-transparent hover:bg-surface-red-3 active:bg-surface-red-4',
    },
  };
  const sizes: Record<Size, string> = {
    sm: 'h-7 text-base px-2 rounded',
    md: 'h-8 text-base font-medium px-2.5 rounded',
    lg: 'h-10 text-lg font-medium px-3 rounded-md',
    xl: 'h-11.5 text-xl font-medium px-3.5 rounded-lg',
    '2xl': 'h-13 text-2xl font-medium px-3.5 rounded-xl',
  };
  return [
    'inline-flex items-center justify-center gap-2 transition-colors focus:outline-none no-underline whitespace-nowrap',
    'focus-visible:ring focus-visible:ring-outline-gray-3',
    variants[variant][theme],
    sizes[size],
  ].join(' ');
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> & {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'subtle' | 'outline' | 'ghost';
};

/**
 * Frappe TextInput (white "outline" variant) accepting normal input attributes. `className`/`style` go on a
 * wrapper (Frappe computes the input's own classes).
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, style, size = 'md', variant = 'outline', ...rest }, ref) {
  // Frappe's TextInput spreads unknown props onto the <input>, so id/name/autoComplete… work as usual.
  const input = <TextInput ref={ref} size={size} variant={variant} {...(rest as Record<string, unknown>)} />;
  return className || style ? (
    <div className={className} style={style}>
      {input}
    </div>
  ) : (
    input
  );
});

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'subtle' | 'outline' | 'ghost';
  children?: ReactNode;
};

/** Frappe Select fed from ordinary <option> children. */
export function Select({ children, value, onChange, disabled, id, className, style, size = 'md', variant = 'outline' }: SelectProps) {
  const options: { value: string; label: string; disabled?: boolean }[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ value?: string; children?: ReactNode; disabled?: boolean }>;
    const label = Children.toArray(el.props.children).join('');
    options.push({ value: String(el.props.value ?? label), label, disabled: el.props.disabled });
  });
  const select = (
    <FrappeSelect
      htmlId={id}
      size={size}
      variant={variant}
      disabled={disabled}
      value={value === undefined ? undefined : String(value)}
      options={options}
      onChange={onChange as ((e: ChangeEvent<HTMLSelectElement>) => void) | undefined}
    />
  );
  return className || style ? (
    <div className={className} style={style}>
      {select}
    </div>
  ) : (
    select
  );
}

type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> & { size?: 'sm' | 'md' | 'lg' | 'xl' };

/** Frappe Textarea. */
export function Textarea({ value, onChange, rows = 3, placeholder, disabled, id, size = 'md' }: TextareaProps) {
  return (
    <FrappeTextarea
      htmlId={id}
      size={size}
      variant="outline"
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      value={value === undefined ? undefined : String(value)}
      onChange={onChange as ((e: ChangeEvent<HTMLTextAreaElement>) => void) | undefined}
    />
  );
}

/** Frappe-style form field: small gray label above the control. */
export function Field({ label, hint, required, children, className }: { label: ReactNode; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className ?? ''}`}>
      <span className="field-label">
        {label}
        {required && <span className="text-ink-red-3"> *</span>}
        {hint && <span className="field-hint"> {hint}</span>}
      </span>
      {children}
    </label>
  );
}

const STATUS_THEME: Record<string, 'gray' | 'blue' | 'green' | 'orange' | 'red'> = {
  OPEN: 'green',
  ACTIVE: 'green',
  SENT: 'green',
  ACCEPTED: 'green',
  INSIDE: 'green',
  VERIFIED: 'green',
  CHECKED: 'green',
  SCHEDULED: 'blue',
  QUEUED: 'orange',
  SENDING: 'orange',
  PENDING: 'orange',
  OVERRIDDEN: 'orange',
  CANCELLED: 'red',
  REVOKED: 'red',
  VOIDED: 'red',
  FAILED: 'red',
  REJECTED: 'red',
  INACTIVE: 'red',
};

export const STATUS_TEXT: Record<string, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  OPEN: 'Open',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
  ARCHIVED: 'Archived',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  REVOKED: 'Revoked',
  VOIDED: 'Voided',
  NOT_REQUIRED: 'Not required',
};

/** Frappe Badge coloured by status. */
export function StatusPill({ status }: { status: string }) {
  const text = STATUS_TEXT[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
  return <Badge theme={STATUS_THEME[status] ?? 'gray'} variant="subtle" size="md" label={text} />;
}

/** Frappe Breadcrumbs wired to the router. The last item (current page) is not a link. */
export function Crumbs({ items, current }: { items: { label: string; to: string }[]; current?: string }) {
  const navigate = useNavigate();
  return (
    <div className="crumbs no-print">
      <Breadcrumbs
        items={[...items.map((i) => ({ label: i.label, onClick: () => navigate(i.to) })), ...(current ? [{ label: current }] : [])]}
      />
    </div>
  );
}
