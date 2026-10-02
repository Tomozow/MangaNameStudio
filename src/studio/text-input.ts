// Bridge to the platform keyboard. Quest Browser shows its system keyboard
// (with Japanese input) when a DOM text field is focused during WebXR; on desktop
// the same field doubles as an IME-friendly overlay.

export interface EditRequest {
  title: string;
  value: string;
  multiline: boolean;
  onInput: (value: string) => void;
  onCommit: (value: string) => void;
}

export class TextInput {
  private readonly wrap = document.createElement('div');
  private readonly title = document.createElement('div');
  private readonly field = document.createElement('textarea');
  private request: EditRequest | null = null;
  private committing = false;

  constructor() {
    Object.assign(this.wrap.style, {
      position: 'fixed',
      left: '50%',
      bottom: '24px',
      transform: 'translateX(-50%)',
      width: 'min(560px, 92vw)',
      padding: '12px',
      borderRadius: '14px',
      background: 'rgba(28,31,36,0.96)',
      boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
      display: 'none',
      zIndex: '1000',
      fontFamily: '"M PLUS 1p", sans-serif',
    } satisfies Partial<CSSStyleDeclaration>);
    Object.assign(this.title.style, { color: '#cfd5de', fontSize: '13px', marginBottom: '6px' });
    Object.assign(this.field.style, {
      width: '100%',
      boxSizing: 'border-box',
      minHeight: '64px',
      fontSize: '18px',
      borderRadius: '8px',
      border: '1px solid #4c8dff',
      padding: '8px',
      background: '#ffffff',
      color: '#1a1a1a',
      resize: 'vertical',
    } satisfies Partial<CSSStyleDeclaration>);
    this.wrap.append(this.title, this.field);
    document.body.append(this.wrap);
    this.field.addEventListener('input', this.onInput);
    this.field.addEventListener('keydown', this.onKeyDown);
    this.field.addEventListener('blur', this.onBlur);
  }

  get active(): boolean {
    return this.request != null;
  }

  open(request: EditRequest): void {
    if (this.request != null) this.commit();
    this.request = request;
    this.title.textContent = `${request.title}  (Enterで確定 / Escで取消${request.multiline ? ' / Shift+Enterで改行(次の行)' : ''})`;
    this.field.value = request.value;
    this.original = request.value;
    this.field.rows = request.multiline ? 3 : 1;
    this.wrap.style.display = 'block';
    this.field.focus();
    this.field.select();
  }

  commit(): void {
    const request = this.request;
    if (request == null || this.committing) return;
    this.committing = true;
    const value = this.normalized();
    this.request = null;
    this.wrap.style.display = 'none';
    this.field.blur();
    request.onCommit(value);
    this.committing = false;
  }

  /** Close and restore the original value. */
  cancel(): void {
    const request = this.request;
    if (request == null) return;
    this.field.value = this.original;
    request.onInput(this.original);
    this.commit();
  }

  private original = '';

  private normalized(): string {
    const value = this.field.value.replace(/\r\n?/g, '\n');
    return this.request?.multiline === false ? value.replace(/\n/g, ' ') : value;
  }

  private readonly onInput = (): void => {
    this.request?.onInput(this.normalized());
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.commit();
    }
  };

  private readonly onBlur = (): void => {
    this.commit();
  };

  dispose(): void {
    this.field.removeEventListener('input', this.onInput);
    this.field.removeEventListener('keydown', this.onKeyDown);
    this.field.removeEventListener('blur', this.onBlur);
    this.wrap.remove();
  }
}
