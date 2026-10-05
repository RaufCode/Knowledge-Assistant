import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { formatFileSize } from '../../../../shared/utils/file-size.util';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/** What the panel accepts, as the design states it. */
const ACCEPTED_EXTENSIONS = ['pdf', 'docx', 'txt'];

const ACCEPT_ATTRIBUTE = '.pdf,.docx,.txt';

/** How the progress bar advances while a file is being taken in. */
const TICK_MS = 120;

/**
 * The upload panel: a drop target that also browses, with a progress bar while a
 * file is being taken in.
 *
 * The file is real, the name and size shown are the file's own, and the type check
 * is real, because all of that happens in the browser and needs no server. The
 * progress is not: nothing is being transmitted, so a bar that climbed to 100% and
 * then said "uploaded" would be claiming work that never happened. It therefore
 * runs as a visible preview and hands the file to the parent, which is the part
 * that has to say uploads are not connected.
 */
@Component({
  selector: 'app-document-dropzone',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div
      class="rounded-lg border border-dashed px-4 py-6 text-center transition-colors"
      [class]="zoneClasses()"
      (dragover)="onDragOver($event)"
      (drop)="onDrop($event)"
    >
      <input
        #picker
        type="file"
        class="sr-only"
        [attr.accept]="accept"
        (change)="onPicked($event)"
      />

      @if (file(); as chosen) {
        <div class="flex items-center justify-center gap-2.5 text-left">
          <app-icon name="file-text" [size]="18" class="shrink-0 text-primary" />

          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-foreground" [title]="chosen.name">
              {{ chosen.name }}
            </p>
            <p class="text-xs text-muted-foreground">{{ sizeLabel(chosen.size) }}</p>
          </div>

          @if (!isBusy()) {
            <button
              app-button
              type="button"
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground"
              aria-label="Choose a different file"
              (click)="clear()"
            >
              <app-icon name="x" [size]="15" />
            </button>
          }
        </div>

        @if (isBusy()) {
          <!--
            A real progressbar role with the value in the attributes, rather than a
            styled div alone, so the state is available to anything reading the
            page instead of only being visible.
          -->
          <div
            class="mt-4 flex items-center gap-3"
            role="progressbar"
            [attr.aria-valuenow]="progress()"
            aria-valuemin="0"
            aria-valuemax="100"
            [attr.aria-label]="'Uploading ' + chosen.name"
          >
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                class="h-full rounded-full bg-primary transition-[width] duration-150
                  ease-linear"
                [style.width.%]="progress()"
              ></div>
            </div>

            <span class="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {{ progress() }}%
            </span>
          </div>
        } @else {
          <div class="mt-4 flex justify-center gap-2">
            <button app-button type="button" (click)="start()">
              <app-icon name="upload" [size]="16" />
              <span>Upload</span>
            </button>
            <button app-button type="button" variant="outline" (click)="clear()">Cancel</button>
          </div>
        }
      } @else {
        <app-icon name="file-plus" [size]="22" class="mx-auto text-muted-foreground" />

        <p class="mt-2 text-sm text-foreground">Drag and drop your file here</p>

        <button app-button type="button" variant="ghost" class="mt-1" (click)="browse()">
          Browse files
        </button>

        <p class="mt-1 text-xs text-muted-foreground">PDF, DOCX, TXT supported</p>
      }

      @if (rejection()) {
        <p class="mt-3 flex items-center justify-center gap-1.5 text-xs text-danger" role="alert">
          <app-icon name="alert-triangle" [size]="14" />
          <span>{{ rejection() }}</span>
        </p>
      }
    </div>
  `,
})
export class DocumentDropzoneComponent {
  /** Emits the file once the preview has run its course. */
  readonly fileAccepted = output<File>();

  /** The file chosen, before or during the preview. */
  protected readonly file = signal<File | null>(null);

  /** How far the preview has run, 0 to 100. */
  protected readonly progress = signal(0);

  /** Why a chosen file was refused, or an empty string. */
  protected readonly rejection = signal('');

  /** Whether the preview is running. */
  protected readonly isBusy = computed(() => this.progress() > 0);

  /** What the file picker accepts, taken from the supported list. */
  protected readonly accept = ACCEPT_ATTRIBUTE;

  private readonly picker = viewChild<ElementRef<HTMLInputElement>>('picker');
  private readonly destroyRef = inject(DestroyRef);

  private tick: ReturnType<typeof setInterval> | undefined;

  /** Zone styling: a file over the target is the one moment it reads as armed. */
  protected readonly zoneClasses = computed(() =>
    this.rejection() === '' ? 'border-border' : 'border-danger/40',
  );

  constructor() {
    this.destroyRef.onDestroy(() => clearInterval(this.tick));
  }

  /**
   * Opens the file picker.
   *
   * Public so the empty state above the table can offer "Upload a document" and
   * land on this panel, rather than adding a row that no file ever produced.
   */
  browse(): void {
    this.picker()?.nativeElement.click();
  }

  /** Accepts a file dropped onto the zone. */
  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.take(event.dataTransfer?.files);
  }

  /**
   * Marks the zone as armed while a file is over it.
   *
   * `preventDefault` is what allows the drop at all, so it is not optional: without
   * it the browser opens the file instead of handing it over.
   */
  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  /** Takes the file away from the picker. */
  protected onPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.take(input.files);
    // Cleared so choosing the same file twice in a row still raises a change event.
    input.value = '';
  }

  /**
   * Validates and holds a chosen file.
   *
   * The extension is the only check available without reading the file, and it is
   * the one the design promises, so it is checked and an unsupported file is
   * refused by name rather than being quietly accepted and failed later.
   */
  private take(files: FileList | null | undefined): void {
    const chosen = files?.[0];

    if (!chosen) {
      return;
    }

    const extension = chosen.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ACCEPTED_EXTENSIONS.includes(extension)) {
      this.file.set(null);
      this.progress.set(0);
      this.rejection.set(
        `${chosen.name} is a .${extension || 'file with no extension'} file. Upload a PDF, DOCX or TXT.`,
      );
      return;
    }

    this.rejection.set('');
    this.file.set(chosen);
    this.progress.set(0);
  }

  /** Forgets the chosen file. */
  protected clear(): void {
    clearInterval(this.tick);
    this.file.set(null);
    this.progress.set(0);
  }

  /**
   * Runs the preview and hands the file over.
   *
   * The bar advances on a timer rather than on real bytes because there are no
   * bytes in flight. It stops short of announcing success on its own: the parent
   * owns that message, because the parent is the one that has to admit the upload
   * went nowhere.
   */
  protected start(): void {
    const chosen = this.file();

    if (!chosen || this.isBusy()) {
      return;
    }

    this.progress.set(0);
    this.tick = setInterval(() => {
      const next = this.progress() + 7;

      if (next >= 100) {
        clearInterval(this.tick);
        this.progress.set(0);
        this.fileAccepted.emit(chosen);
        return;
      }

      this.progress.set(next);
    }, TICK_MS);
  }

  /** A file size as a reader would say it, which is not bytes. */
  protected sizeLabel(bytes: number): string {
    return formatFileSize(bytes);
  }
}
