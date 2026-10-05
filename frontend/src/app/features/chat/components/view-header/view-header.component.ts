import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import { LayoutService } from '../../../../core/services/layout.service';
import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * The header strip every view sits under: the sidebar toggle and the view
 * title, centred.
 *
 * Below `lg` the sidebar is an overlay drawer, so the closed drawer cannot show
 * the product name. The header stands in for it there, with the toggle on the
 * trailing edge; from `lg` up the sidebar is on screen, so the header goes
 * back to a centred title with the toggle on the leading edge.
 *
 * Every one of those choices is made by a `lg` variant rather than by reading
 * the viewport in TypeScript, so the header is already correct on the first
 * paint. Switching the glyph from a menu to a panel once hydration caught up
 * meant phones briefly showed the wrong icon.
 *
 * The two glyphs each sit in a wrapper instead of carrying the visibility
 * utility themselves. `app-icon` sets `inline-flex` on its own host, and two
 * display utilities of equal weight are settled by stylesheet order, not by the
 * order they appear in the class attribute, so `hidden` on the host lost and
 * both icons drew at once. A wrapper with no display utility of its own is
 * hidden reliably.
 *
 * It carries a minimum height because above `lg` the toggle leaves the flow: on
 * a screen with no title — the assistant's own landing page — nothing is left
 * to give the strip any, so it collapsed to its padding while every titled
 * screen kept the height a title needs. The bar is the one thing that does not
 * move between screens, and it should not.
 *
 * It owns no state of its own; the toggle delegates to `LayoutService`.
 */
@Component({
  selector: 'app-view-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: {
    class:
      'relative flex min-h-header shrink-0 items-center justify-between gap-3 border-b ' +
      'border-border bg-card px-4 py-4 sm:px-6 lg:justify-center lg:py-4 lg:px-8',
  },
  template: `
    <span class="truncate font-headings text-base font-semibold text-foreground lg:hidden">
      Knowledge Assistant
    </span>

    @if (title()) {
      <h1
        class="hidden min-w-0 truncate px-10 text-center font-headings text-base font-semibold text-foreground sm:text-lg lg:block"
      >
        {{ title() }}
      </h1>
    }

    <button
      app-button
      type="button"
      variant="ghost"
      tone="brand"
      size="icon"
      class="ml-auto shrink-0 lg:absolute lg:top-1/2 lg:left-6 lg:ml-0 lg:-translate-y-1/2"
      [attr.aria-label]="layout.toggleLabel()"
      [attr.aria-expanded]="layout.isSidebarVisible()"
      aria-controls="app-sidebar"
      (click)="layout.toggleSidebar()"
    >
      <span class="lg:hidden"><app-icon name="menu" [size]="18" /></span>
      <span class="hidden lg:flex"><app-icon name="panel-left" [size]="18" /></span>
    </button>
  `,
})
export class ViewHeaderComponent {
  /** Layout state, so the toggle always matches what is on screen. */
  protected readonly layout = inject(LayoutService);

  /** Primary heading of the view. */
  readonly title = input('');
}
