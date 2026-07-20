import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * Compact "← Back" control. Defaults to `navigate(-1)` so it pops the history
 * stack like a native back button. Pass `to` to send the user to a specific
 * route instead — useful when the previous route was a transient flow (login,
 * payment) where popping would feel wrong.
 *
 * Designed to sit at the top-left of any inner page that doesn't have its own
 * navigation chrome. The Navbar is global, but the navbar's brand/logo isn't
 * a substitute for an explicit back affordance on dedicated flows.
 */
interface BackButtonProps {
  to?: string;
  label?: string;
  className?: string;
}

const BackButton = ({ to, label = "Back", className = "" }: BackButtonProps) => {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => (to ? navigate(to) : navigate(-1))}
      className={`inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors ${className}`}
    >
      <ArrowLeft className="w-4 h-4" />
      {label}
    </button>
  );
};

export default BackButton;
