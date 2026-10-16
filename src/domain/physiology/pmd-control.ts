/**
 * Responses from the PMD control point (fb005c81), delivered as indications:
 * [0xF0][opCode][measurementType][errorCode][more][...params]
 */

export interface PmdControlResponse {
  readonly opCode: number;
  readonly measurementType: number;
  readonly errorCode: number;
}

const RESPONSE_CODE = 0xf0;

export function parsePmdControlResponse(bytes: Uint8Array): PmdControlResponse | null {
  if (bytes.length < 4 || bytes[0] !== RESPONSE_CODE) return null; // feature-read reply or unrelated
  return { opCode: bytes[1]!, measurementType: bytes[2]!, errorCode: bytes[3]! };
}

export const PMD_SUCCESS = 0x00;
/** Stream is already running: a previous session left it on. Not a failure. */
export const PMD_ALREADY_IN_STATE = 0x06;

const ERROR_TEXT: Record<number, string> = {
  0x01: 'comando inválido',
  0x02: 'medição não suportada',
  0x03: 'medição não suportada',
  0x04: 'comando com tamanho inválido',
  0x05: 'parâmetro inválido',
  0x07: 'resolução inválida',
  0x08: 'frequência inválida',
  0x09: 'faixa inválida',
  0x0a: 'MTU insuficiente',
  0x0b: 'número de canais inválido',
  0x0c: 'estado inválido — a cinta precisa estar no peito, com contato',
  0x0d: 'a cinta está no carregador',
};

export function pmdErrorText(code: number): string {
  return ERROR_TEXT[code] ?? `erro 0x${code.toString(16).padStart(2, '0')}`;
}
