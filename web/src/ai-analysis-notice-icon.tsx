import { useEffect, useId, useRef, useState } from "preact/hooks";

type AiUnverifiedMarkProps = Readonly<{
  ariaLabel?: string;
  description: string;
}>;

type TooltipPosition = Readonly<{
  left: number;
  top: number;
}>;

const TOOLTIP_WIDTH = 288;
const TOOLTIP_ESTIMATED_HEIGHT = 96;
const TOOLTIP_VIEWPORT_MARGIN = 8;

/** AI分析に関する注意を警告記号で示す。 */
export function AiUnverifiedMark({ ariaLabel, description }: AiUnverifiedMarkProps) {
  const button = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>({ left: 0, top: 0 });
  const expanded = focused || hovered || pinned;

  function updatePosition(): void {
    const buttonElement = button.current;
    if (buttonElement == null) {
      throw new TypeError("AI未検証マークのbuttonがありません");
    }
    const bounds = buttonElement.getBoundingClientRect();
    const tooltipBounds = tooltip.current?.getBoundingClientRect();
    const tooltipWidth =
      tooltipBounds != null && tooltipBounds.width > 0
        ? tooltipBounds.width
        : Math.min(TOOLTIP_WIDTH, window.innerWidth - 2 * TOOLTIP_VIEWPORT_MARGIN);
    const tooltipHeight =
      tooltipBounds != null && tooltipBounds.height > 0
        ? tooltipBounds.height
        : TOOLTIP_ESTIMATED_HEIGHT;
    const maximumLeft = Math.max(
      TOOLTIP_VIEWPORT_MARGIN,
      window.innerWidth - tooltipWidth - TOOLTIP_VIEWPORT_MARGIN,
    );
    const left = Math.min(
      Math.max(TOOLTIP_VIEWPORT_MARGIN, bounds.left + bounds.width / 2 - tooltipWidth / 2),
      maximumLeft,
    );
    const below = bounds.bottom + TOOLTIP_VIEWPORT_MARGIN;
    const top =
      below + tooltipHeight <= window.innerHeight - TOOLTIP_VIEWPORT_MARGIN
        ? below
        : Math.max(TOOLTIP_VIEWPORT_MARGIN, bounds.top - tooltipHeight - TOOLTIP_VIEWPORT_MARGIN);
    setPosition({ left, top });
  }

  useEffect(() => {
    if (!expanded) {
      return;
    }
    updatePosition();
    const hide = (): void => {
      setFocused(false);
      setHovered(false);
      setPinned(false);
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) {
        throw new TypeError("pointer eventのtargetがNodeではありません");
      }
      if (container.current?.contains(event.target) === true) {
        return;
      }
      hide();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      hide();
      button.current?.blur();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [description, expanded]);

  return (
    <span
      class="ai-unverified-mark relative inline-flex shrink-0 align-[-0.125em] leading-none"
      ref={container}
    >
      <button
        ref={button}
        aria-describedby={tooltipId}
        aria-expanded={expanded}
        aria-label={ariaLabel ?? "現在入力で未検証"}
        class="inline-flex size-6 cursor-help items-center justify-center rounded-sm border-0 bg-transparent p-1 text-state-warning-text hover:bg-state-warning-background focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-focus-ring"
        type="button"
        onBlur={() => {
          setFocused(false);
          setPinned(false);
        }}
        onClick={() => {
          updatePosition();
          setPinned(true);
        }}
        onFocus={() => {
          updatePosition();
          setFocused(true);
        }}
        onMouseEnter={() => {
          updatePosition();
          setHovered(true);
        }}
        onMouseLeave={() => {
          setHovered(false);
        }}
      >
        <svg
          class="block size-full"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3 22 21H2Z" />
          <path d="M12 9V14" />
          <circle cx="12" cy="17.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <span
        ref={tooltip}
        id={tooltipId}
        class="fixed z-50 w-72 max-w-[calc(100vw-1rem)] rounded-lg border border-state-warning-border bg-surface-card px-3 py-2 text-left text-xs leading-5 font-normal whitespace-normal text-text-primary shadow-card"
        hidden={!expanded}
        role="tooltip"
        style={{ left: position.left, top: position.top }}
      >
        {description}
      </span>
    </span>
  );
}
