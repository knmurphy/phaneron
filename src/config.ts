/*
  Phaneron - Clustered, accelerated and cloud-fit video server, pre-assembled and in kit form.
  Copyright (C) 2020 Streampunk Media Ltd.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
  https://www.streampunk.media/ mailto:furnace@streampunk.media
  14 Ormiscaig, Aultbea, Achnasheen, IV22 2JJ  U.K.
*/

type VideoFormat = {
	name: string
	fields: number
	width: number
	height: number
	squareWidth: number
	squareHeight: number
	timescale: number
	duration: number
	audioSampleRate: number
}

class VideoFormats {
	private formats: Map<string, VideoFormat>

	constructor() {
		this.formats = new Map<string, VideoFormat>()
		this.formats.set('1080i5000', {
			name: '1080i5000',
			fields: 2,
			width: 1920,
			height: 1080,
			squareWidth: 1920,
			squareHeight: 1080,
			timescale: 50,
			duration: 1,
			audioSampleRate: 48000
		})
		this.formats.set('1080p5000', {
			name: '1080p5000',
			fields: 1,
			width: 1920,
			height: 1080,
			squareWidth: 1920,
			squareHeight: 1080,
			timescale: 50,
			duration: 1,
			audioSampleRate: 48000
		})
	}

	get(name: string): VideoFormat {
		const format = this.formats.get(name)
		if (!format) throw new Error(`Video format ${name} not found`)
		return format
	}
}

interface DeviceConfig {
	name: string
	deviceIndex: number
	[key: string]: unknown
}

interface DecklinkConfig extends DeviceConfig {
	keyDeviceIndex: number
	embeddedAudio: boolean
	latency: 'normal' | 'low' | 'default'
	keyer: 'external' | 'external_separate_device' | 'internal' | 'default'
	keyOnly: boolean
	bufferDepth: number
}

const decklinkDefaults: DecklinkConfig = {
	name: 'decklink',
	deviceIndex: 1,
	keyDeviceIndex: 0,
	embeddedAudio: false,
	latency: 'normal',
	keyer: 'external',
	keyOnly: false,
	bufferDepth: 3
}

export interface ConsumerConfig {
	format: VideoFormat
	device: DeviceConfig
}

export class Config {
	private readonly videoFormats: VideoFormats
	readonly consumers: ConsumerConfig[]

	constructor() {
		this.videoFormats = new VideoFormats()
		this.consumers = [
			{
				format: this.videoFormats.get('1080i5000'),
				device: Object.assign(
					{ ...decklinkDefaults },
					{
						deviceIndex: 1,
						embeddedAudio: true
					}
				)
			},
			{
				format: this.videoFormats.get('1080i5000'),
				device: Object.assign(
					{ ...decklinkDefaults },
					{
						deviceIndex: 2,
						embeddedAudio: true
					}
				)
			},
			{
				format: this.videoFormats.get('1080i5000'),
				device: Object.assign(
					{ ...decklinkDefaults },
					{
						deviceIndex: 3,
						embeddedAudio: true
					}
				)
			},
			{
				format: this.videoFormats.get('1080i5000'),
				device: Object.assign(
					{ ...decklinkDefaults },
					{
						deviceIndex: 4,
						embeddedAudio: true
					}
				)
			}
		]
	}
}
