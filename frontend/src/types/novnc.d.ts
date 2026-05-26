declare module "@novnc/novnc" {
  interface RFBEventDetail {
    clean?: boolean;
    reason?: string;
    status?: number;
    types?: string[];
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
    sendCredentials(credentials: { password?: string; username?: string; target?: string }): void;
    addEventListener(type: string, listener: (event: CustomEvent<RFBEventDetail>) => void): void;
  }

  export default RFB;
}
