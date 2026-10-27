import { writeText } from '@tauri-apps/plugin-clipboard-manager'

export async function copyText(text: string): Promise<void> {
  await writeText(text)
}
