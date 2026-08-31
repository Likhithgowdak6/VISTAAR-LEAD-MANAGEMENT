declare module 'qrcode-terminal' {
  interface QrcodeTerminal {
    generate: (input: string, options?: { small?: boolean }) => void;
  }

  const qrcodeTerminal: QrcodeTerminal;
  export default qrcodeTerminal;
}
