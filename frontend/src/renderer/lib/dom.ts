type Props = {
  class?: string
  text?: string
  html?: string
  title?: string
  type?: string
  value?: string
  placeholder?: string
  min?: string
  max?: string
  step?: string
  checked?: boolean
  disabled?: boolean
  dataset?: Record<string, string>
  attrs?: Record<string, string | number | boolean>
  style?: Partial<CSSStyleDeclaration>
  on?: Record<string, (event: Event) => void>
}

/** ~40 lines of DOM sugar instead of a framework. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Array<Node | string | null | undefined> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.class) node.className = props.class
  if (props.text !== undefined) node.textContent = props.text
  if (props.html !== undefined) node.innerHTML = props.html
  if (props.title) node.title = props.title
  if (props.type !== undefined) (node as HTMLInputElement).type = props.type
  if (props.value !== undefined) (node as HTMLInputElement).value = props.value
  if (props.placeholder !== undefined) (node as HTMLInputElement).placeholder = props.placeholder
  if (props.min !== undefined) (node as HTMLInputElement).min = props.min
  if (props.max !== undefined) (node as HTMLInputElement).max = props.max
  if (props.step !== undefined) (node as HTMLInputElement).step = props.step
  if (props.checked !== undefined) (node as HTMLInputElement).checked = props.checked
  if (props.disabled !== undefined) (node as HTMLButtonElement).disabled = props.disabled
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) node.setAttribute(k, String(v))
  if (props.style) Object.assign(node.style, props.style)
  if (props.on) for (const [event, handler] of Object.entries(props.on)) node.addEventListener(event, handler)
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector)
  if (!found) throw new Error(`missing element: ${selector}`)
  return found
}

/**
 * Sizes a canvas for the device pixel ratio and returns a context already
 * scaled to CSS pixels, so all drawing code can pretend DPR is 1.
 */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number
): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(cssWidth * dpr)
  canvas.height = Math.round(cssHeight * dpr)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${cssHeight}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}
