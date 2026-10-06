import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Every icon the shell uses, so `name` stays a closed, typo-proof set. */
export type IconName =
  | 'arrow-left'
  | 'arrow-up-right'
  | 'bot'
  | 'check'
  | 'check-circle-2'
  | 'clock'
  | 'compass'
  | 'copy'
  | 'file-text'
  | 'gauge'
  | 'info'
  | 'loader-2'
  | 'menu'
  | 'message-square-text'
  | 'more-horizontal'
  | 'panel-left'
  | 'paperclip'
  | 'pencil'
  | 'plus'
  | 'search'
  | 'search-x'
  | 'send-horizontal'
  | 'share-2'
  | 'shield-check'
  | 'alert-triangle'
  | 'chevron-down'
  | 'circle-user'
  | 'eye'
  | 'eye-off'
  | 'file-plus'
  | 'key-round'
  | 'layout-dashboard'
  | 'lock'
  | 'log-out'
  | 'mail'
  | 'refresh-cw'
  | 'shield'
  | 'trash-2'
  | 'upload'
  | 'user'
  | 'user-plus'
  | 'users'
  | 'x';

/**
 * Optical stroke weight held constant across sizes: the design renders these
 * glyphs on a 24px grid, so a stroke of `OPTICAL_STROKE / size` keeps every
 * icon looking equally weighted.
 */
const OPTICAL_STROKE = 48;

/**
   * Renders one stroked icon at a pixel size. Purely presentational: it takes a
   * name and a size and knows nothing about the domain.
   *
   * The set is closed so a typo fails the build rather than rendering an empty
   * `<svg>`: an icon that silently draws nothing looks like a layout mistake, and
   * costs a screenshot to find.
   */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex shrink-0 items-center justify-center leading-none',
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[attr.aria-hidden]': "label() ? null : 'true'",
    '[attr.role]': "label() ? 'img' : null",
    '[attr.aria-label]': 'label()',
  },
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      [attr.stroke-width]="strokeWidth()"
      focusable="false"
    >
      @switch (name()) {
        @case ('arrow-up-right') {
          <path d="M7 7h10v10M7 17L17 7" />
        }
        @case ('bot') {
          <g>
            <path d="M12 8V4H8" />
            <rect width="16" height="12" x="4" y="8" rx="2" />
            <path d="M2 14h2m16 0h2m-7-1v2m-6-2v2" />
          </g>
        }
        @case ('check') {
          <path d="M20 6L9 17l-5-5" />
        }
        @case ('check-circle-2') {
          <g>
            <circle cx="12" cy="12" r="10" />
            <path d="m9 12l2 2l4-4" />
          </g>
        }
        @case ('clock') {
          <g>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </g>
        }
        @case ('compass') {
          <g>
            <circle cx="12" cy="12" r="10" />
            <path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z" />
          </g>
        }
        @case ('copy') {
          <g>
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </g>
        }
        @case ('file-text') {
          <g>
            <path
              d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"
            />
            <path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8" />
          </g>
        }
        @case ('gauge') {
          <g>
            <path d="m12 14 4-4" />
            <path d="M3.34 19a10 10 0 1 1 17.32 0" />
          </g>
        }
        @case ('info') {
          <g>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4m0-4h.01" />
          </g>
        }
        @case ('loader-2') {
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        }
        @case ('menu') {
          <path d="M4 6h16M4 12h16M4 18h16" />
        }
        @case ('message-square-text') {
          <path
            d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2zM7 11h10M7 15h6M7 7h8"
          />
        }
        @case ('more-horizontal') {
          <g>
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
            <circle cx="5" cy="12" r="1" />
          </g>
        }
        @case ('panel-left') {
          <g>
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18" />
          </g>
        }
        @case ('arrow-left') {
          <g>
            <path d="M19 12H5" />
            <path d="m12 19-7-7 7-7" />
          </g>
        }
        @case ('paperclip') {
          <path
            d="m16 6l-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"
          />
        }
        @case ('pencil') {
          <g>
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
            <path d="m15 5 4 4" />
          </g>
        }
        @case ('plus') {
          <path d="M5 12h14m-7-7v14" />
        }
        @case ('search') {
          <g>
            <path d="m21 21l-4.34-4.34" />
            <circle cx="11" cy="11" r="8" />
          </g>
        }
        @case ('search-x') {
          <g>
            <path d="m13.5 8.5l-5 5m0-5l5 5" />
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21l-4.3-4.3" />
          </g>
        }
        @case ('send-horizontal') {
          <path
            d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904zM6 12h16"
          />
        }
        @case ('share-2') {
          <g>
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="m8.59 13.51l6.83 3.98m-.01-10.98l-6.82 3.98" />
          </g>
        }
        @case ('shield-check') {
          <g>
            <path
              d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
            />
            <path d="m9 12 2 2 4-4" />
          </g>
        }
        @case ('alert-triangle') {
          <g>
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4m0 4h.01" />
          </g>
        }
        @case ('chevron-down') {
          <path d="m6 9 6 6 6-6" />
        }
        @case ('circle-user') {
          <g>
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="10" r="3" />
            <path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662" />
          </g>
        }
        @case ('eye') {
          <g>
            <path
              d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
            />
            <circle cx="12" cy="12" r="3" />
          </g>
        }
        @case ('eye-off') {
          <g>
            <path
              d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"
            />
            <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
            <path
              d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"
            />
            <path d="m2 2 20 20" />
          </g>
        }
        @case ('file-plus') {
          <g>
            <path
              d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"
            />
            <path d="M14 2v5a1 1 0 0 0 1 1h5M9 15h6m-3-3v6" />
          </g>
        }
        @case ('key-round') {
          <g>
            <path
              d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"
            />
            <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
          </g>
        }
        @case ('layout-dashboard') {
          <g>
            <rect width="7" height="9" x="3" y="3" rx="1" />
            <rect width="7" height="5" x="14" y="3" rx="1" />
            <rect width="7" height="9" x="14" y="12" rx="1" />
            <rect width="7" height="5" x="3" y="16" rx="1" />
          </g>
        }
        @case ('lock') {
          <g>
            <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </g>
        }
        @case ('log-out') {
          <g>
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="m16 17 5-5-5-5M21 12H9" />
          </g>
        }
        @case ('mail') {
          <g>
            <rect width="20" height="16" x="2" y="4" rx="2" />
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
          </g>
        }
        @case ('refresh-cw') {
          <g>
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </g>
        }
        @case ('shield') {
          <path
            d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
          />
        }
        @case ('trash-2') {
          <g>
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M10 11v6m4-6v6" />
          </g>
        }
        @case ('upload') {
          <g>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="m17 8-5-5-5 5M12 3v12" />
          </g>
        }
        @case ('user') {
          <g>
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </g>
        }
        @case ('user-plus') {
          <g>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M19 8v6M22 11h-6" />
          </g>
        }
        @case ('users') {
          <g>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </g>
        }
        @case ('x') {
          <path d="M18 6L6 18M6 6l12 12" />
        }
      }
    </svg>
  `,
})
export class IconComponent {
  /** Which icon to draw. */
  readonly name = input.required<IconName>();

  /** Rendered width and height, in pixels. */
  readonly size = input(16);

  /** Accessible label. Omit for decorative icons. */
  readonly label = input<string | undefined>(undefined);

  /** Stroke width that keeps the optical weight constant at any size. */
  protected readonly strokeWidth = computed(() =>
    Number((OPTICAL_STROKE / this.size()).toFixed(2)),
  );
}
