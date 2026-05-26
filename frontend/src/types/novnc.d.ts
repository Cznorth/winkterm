declare module "@novnc/novnc" {
  interface RFBEventDetail {
    clean?: boolean;
    reason?: string;
  }

  class RFB {
    constructor(
      el: HTMLElement,
      url: string,
      options?: { shared?: boolean; credentials?: { password?: string } }
    );

    scaleViewport: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    viewOnly: boolean;
    disconnect(): void;
    requestResize(width: number, height: number): void;
    addEventListener(type: string, listener: () => void): void;
  }

  export default RFB;
}
