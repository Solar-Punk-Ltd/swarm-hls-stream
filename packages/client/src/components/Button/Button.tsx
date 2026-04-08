import './Button.scss';

export enum ButtonVariant {
  PRIMARY = 'primary',
  SECONDARY = 'secondary',
}

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
}

export function Button({ children, onClick, className, variant = ButtonVariant.PRIMARY, disabled }: ButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`button ${variant} ${className ? className : ''} ${disabled ? 'disabled' : ''}`.trim()}
    >
      {children}
    </button>
  );
}
