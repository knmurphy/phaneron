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

import { ProducerFactory, Producer, InvalidProducerError } from './producer'
import { clContext as nodenCLContext, OpenCLBuffer } from 'nodencl'
import {
	Demuxer,
	demuxer,
	Decoder,
	decoder,
	Filterer,
	filterer,
	Stream,
	Packet,
	Frame,
	frame
} from 'beamcoder'
import redio, { RedioPipe, nil, end, isValue, RedioEnd, Generator, Valve } from 'redioactive'
import { LoadParams, ChanProperties } from '../chanLayer'
import { ToRGBA } from '../process/io'
import { Reader as yuv422p10Reader } from '../process/yuv422p10'
import { Reader as yuv422p8Reader } from '../process/yuv422p8'
import { Reader as v210Reader } from '../process/v210'
import { Reader as rgba8Reader } from '../process/rgba8'
import { Reader as bgra8Reader } from '../process/bgra8'
import Yadif from '../process/yadif'

interface AudioChannel {
	name: string
	frames: Frame[]
}

export class FFmpegProducer implements Producer {
	private readonly loadParams: LoadParams
	private readonly clContext: nodenCLContext
	private demuxer: Demuxer | null = null
	private audSource: RedioPipe<Frame | RedioEnd> | undefined
	private vidSource: RedioPipe<OpenCLBuffer | RedioEnd> | undefined
	private running = true
	private paused = false

	constructor(loadParams: LoadParams, context: nodenCLContext) {
		this.loadParams = loadParams
		this.clContext = context
	}

	async initialise(chanProperties: ChanProperties): Promise<void> {
		try {
			this.demuxer = await demuxer(this.loadParams.url)
		} catch (err) {
			console.log(err)
			throw new InvalidProducerError(err)
		}
		if (this.loadParams.seek) await this.demuxer.seek({ time: this.loadParams.seek })

		// const streams: Stream[] = []
		const audioStreams: Stream[] = []
		const videoStreams: Stream[] = []
		const audioIndexes: number[] = []
		const videoIndexes: number[] = []
		const decoders: Map<number, Decoder> = new Map()
		const numAudChannels = 8
		const numVidChannels = 1
		this.demuxer.streams.forEach((s) => {
			if (s.codecpar.codec_type === 'audio' && audioStreams.length < numAudChannels) {
				s.discard = 'default'
				audioStreams.push(s)
				audioIndexes.push(s.index)
				decoders.set(s.index, decoder({ demuxer: this.demuxer as Demuxer, stream_index: s.index }))
			} else if (s.codecpar.codec_type === 'video' && videoStreams.length < numVidChannels) {
				s.discard = 'default'
				videoStreams.push(s)
				videoIndexes.push(s.index)
				decoders.set(s.index, decoder({ demuxer: this.demuxer as Demuxer, stream_index: s.index }))
			} else {
				s.discard = 'all'
			}
		})

		let silentFrame: Frame | null = null
		let audFilterer: Filterer | null = null
		const audLayout = `${numAudChannels}c`
		// If the file has multiple audio streams each marked as mono then set the channel layout to give them a default position
		const allMono = audioStreams.every((s) => s.codecpar.channel_layout === 'mono')
		const audChanNames = ['FL', 'FR', 'FC', 'SL', 'SR', 'LFE', 'BL', 'BR']
		const audStream = audioStreams[0]
		if (audStream) {
			let inStr = ''
			const inParams = audioStreams.map((_s, i) => {
				inStr += `[in${i}:a]`
				return {
					name: `in${i}:a`,
					timeBase: audStream.time_base,
					sampleRate: audStream.codecpar.sample_rate,
					sampleFormat: audStream.codecpar.format,
					channelLayout: allMono ? audChanNames[i] : audStream.codecpar.channel_layout
				}
			})

			audFilterer = await filterer({
				filterType: 'audio',
				inputParams: inParams,
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: 48000,
						sampleFormat: 's32',
						channelLayout: audLayout
					}
				],
				filterSpec: `${inStr} amerge=inputs=${audioStreams.length}, asetnsamples=n=1024:p=1 [out0:a]`
			})
		} else {
			silentFrame = frame({
				nb_samples: 1024,
				format: 's32',
				pts: 0,
				sample_rate: 48000,
				channels: numAudChannels,
				channel_layout: audLayout,
				data: [Buffer.alloc(1024 * numAudChannels * 4)]
			})

			audFilterer = await filterer({
				filterType: 'audio',
				inputParams: [
					{
						name: 'in0:a',
						timeBase: [1, 48000],
						sampleRate: 48000,
						sampleFormat: 's32',
						channelLayout: audLayout
					}
				],
				outputParams: [
					{
						name: 'out0:a',
						sampleRate: 48000,
						sampleFormat: 's32',
						channelLayout: audLayout
					}
				],
				filterSpec: '[in0:a] asetpts=N/SR/TB [out0:a]'
			})
		}
		// console.log('\nFFmpeg producer audio:\n', audFilterer.graph.dump())

		const vidStream = videoStreams[0]
		const width = vidStream.codecpar.width
		const height = vidStream.codecpar.height

		let toRGBA: ToRGBA | null = null
		let filterOutputFormat = vidStream.codecpar.format
		switch (vidStream.codecpar.format) {
			case 'yuv422p':
				console.log('Using native yuv422p8 loader')
				toRGBA = new ToRGBA(this.clContext, '709', '709', new yuv422p8Reader(width, height))
				break
			case 'yuv422p10le':
				console.log('Using native yuv422p10 loader')
				toRGBA = new ToRGBA(this.clContext, '709', '709', new yuv422p10Reader(width, height))
				break
			case 'v210':
				console.log('Using native v210 loader')
				toRGBA = new ToRGBA(this.clContext, '709', '709', new v210Reader(width, height))
				break
			case 'rgba':
				console.log('Using native rgba8 loader')
				toRGBA = new ToRGBA(this.clContext, '709', '709', new rgba8Reader(width, height))
				break
			case 'bgra':
				console.log('Using native bgra8 loader')
				toRGBA = new ToRGBA(this.clContext, '709', '709', new bgra8Reader(width, height))
				break
			default:
				if (vidStream.codecpar.format.includes('yuv')) {
					console.log(`Non-native loader for ${vidStream.codecpar.format} - using yuv422p10`)
					filterOutputFormat = 'yuv422p10le'
					toRGBA = new ToRGBA(this.clContext, '709', '709', new yuv422p10Reader(width, height))
				} else if (vidStream.codecpar.format.includes('rgb')) {
					console.log(`Non-native loader for ${vidStream.codecpar.format} - using rgba8`)
					filterOutputFormat = 'rgba'
					toRGBA = new ToRGBA(this.clContext, '709', '709', new rgba8Reader(width, height))
				} else
					throw new Error(
						`Unsupported video format '${vidStream.codecpar.format}' from FFmpeg decoder`
					)
		}
		await toRGBA.init()
		const chanTb = chanProperties.videoTimebase
		const vidFilterer = await filterer({
			filterType: 'video',
			inputParams: [
				{
					timeBase: vidStream.time_base,
					width: width,
					height: height,
					pixelFormat: vidStream.codecpar.format,
					pixelAspect: vidStream.codecpar.sample_aspect_ratio
				}
			],
			outputParams: [
				{
					pixelFormat: filterOutputFormat
				}
			],
			filterSpec: `fps=fps=${chanTb[1] / 2}/${chanTb[0]}`
		})
		// console.log('\nFFmpeg producer video:\n', vidFilterer.graph.dump())

		let yadif: Yadif | null = null
		yadif = new Yadif(this.clContext, width, height, 'send_field', 'tff', 'all')
		await yadif.init()

		const demux: Generator<Packet[] | RedioEnd> = async () => {
			let result: Packet[] | RedioEnd = end
			let doneSet = false

			let lastAudTimestamp: number | undefined = undefined
			let lastVidTimestamp: number | undefined = undefined
			const packets: Packet[] = []
			let doBreak = false

			if (this.demuxer && this.running) {
				do {
					const packet = await this.demuxer.read()
					if (packet) {
						if (audioIndexes.includes(packet.stream_index)) {
							if (!lastAudTimestamp) lastAudTimestamp = packet.pts
							else if (packet.pts !== lastAudTimestamp) doBreak = true
							packets.push(packet)
						} else if (videoIndexes.includes(packet.stream_index)) {
							if (!lastVidTimestamp) lastVidTimestamp = packet.pts
							else if (packet.pts !== lastVidTimestamp) doBreak = true
							packets.push(packet)
						}

						if (doBreak || packets.length === audioStreams.length + videoStreams.length) {
							if (doBreak)
								console.log(
									`Timestamp mismatch - sending ${packets.length} packets, ${
										audioStreams.length + videoStreams.length
									} expected`
								)
							doneSet = true
							result = packets
						}
					} else {
						doneSet = true
						result = end
					}
				} while (!doneSet)
			} else this.demuxer = null

			return result
		}

		const audPacketFilter: Valve<Packet[] | RedioEnd, Packet[] | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				return packets.filter((p) => audioIndexes.includes(p.stream_index))
			} else {
				return packets
			}
		}

		const audDecode: Valve<Packet[] | RedioEnd, AudioChannel[] | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				const frames = await Promise.all(
					packets.map((p) => (decoders.get(p.stream_index) as Decoder).decode(p))
				)
				return frames.map((f, i) => ({ name: `in${i}:a`, frames: f.frames }))
			} else {
				return packets
			}
		}

		const audFilter: Valve<AudioChannel[] | RedioEnd, Frame | RedioEnd> = async (frames) => {
			if (isValue(frames) && audFilterer) {
				const ff = await audFilterer.filter(frames)
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return frames as RedioEnd
			}
		}

		const silence: Generator<AudioChannel[] | RedioEnd> = async () => [
			{ name: 'in0:a', frames: [silentFrame] }
		]

		const vidPacketFilter: Valve<Packet[] | RedioEnd, Packet[] | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				return packets.filter((p) => videoIndexes.includes(p.stream_index))
			} else {
				return packets
			}
		}

		const vidDecode: Valve<Packet[] | RedioEnd, Frame | RedioEnd> = async (packets) => {
			if (isValue(packets)) {
				const frm = await (decoders.get(packets[0].stream_index) as Decoder).decode(packets[0])
				return frm.frames.length > 0 ? frm.frames : nil
			} else {
				return packets
			}
		}

		const vidFilter: Valve<Frame | RedioEnd, Frame | RedioEnd> = async (decFrames) => {
			if (isValue(decFrames)) {
				const ff = await vidFilterer.filter([decFrames])
				return ff[0].frames.length > 0 ? ff[0].frames : nil
			} else {
				return decFrames
			}
		}

		const vidLoader: Valve<Frame | RedioEnd, OpenCLBuffer[] | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const convert = toRGBA as ToRGBA
				const clSources = await convert.createSources()
				clSources.forEach((s) => (s.timestamp = frame.pts))
				await convert.loadFrame(frame.data, clSources, this.clContext.queue.load)
				await this.clContext.waitFinish(this.clContext.queue.load)
				return clSources
			} else {
				return frame
			}
		}

		const vidProcess: Valve<OpenCLBuffer[] | RedioEnd, OpenCLBuffer | RedioEnd> = async (
			clSources
		) => {
			if (isValue(clSources)) {
				const convert = toRGBA as ToRGBA
				const clDest = await convert.createDest({ width: width, height: height })
				clDest.timestamp = clSources[0].timestamp
				await convert.processFrame(clSources, clDest, this.clContext.queue.process)
				await this.clContext.waitFinish(this.clContext.queue.process)
				clSources.forEach((s) => s.release())
				return clDest
			} else {
				toRGBA = null
				return clSources
			}
		}

		const vidDeint: Valve<OpenCLBuffer | RedioEnd, OpenCLBuffer | RedioEnd> = async (frame) => {
			if (isValue(frame)) {
				const yadifDests: OpenCLBuffer[] = []
				await yadif?.processFrame(frame, yadifDests, this.clContext.queue.process)
				await this.clContext.waitFinish(this.clContext.queue.process)
				frame.release()
				return yadifDests.length > 1 ? yadifDests : nil
			} else {
				yadif?.release()
				yadif = null
				return frame
			}
		}

		const ffPackets = redio(demux, { bufferSizeMax: 10 })

		if (audioStreams.length) {
			this.audSource = ffPackets
				.fork()
				.valve(audPacketFilter)
				.valve(audDecode)
				.valve(audFilter, { oneToMany: true })
		} else {
			// eslint-disable-next-line prettier/prettier
			this.audSource = redio(silence, { bufferSizeMax: 10 })
				.valve(audFilter, { oneToMany: true })
		}

		this.vidSource = ffPackets
			.fork()
			.valve(vidPacketFilter)
			.valve(vidDecode, { oneToMany: true })
			.valve(vidFilter, { oneToMany: true })
			.valve(vidLoader, { bufferSizeMax: 3 })
			.valve(vidProcess)
			.valve(vidDeint, { oneToMany: true })

		console.log(`Created FFmpeg producer for path ${this.loadParams.url}`)
	}

	getSourceAudio(): RedioPipe<Frame | RedioEnd> | undefined {
		return this.audSource
	}

	getSourceVideo(): RedioPipe<OpenCLBuffer | RedioEnd> | undefined {
		return this.vidSource
	}

	setPaused(pause: boolean): void {
		this.paused = pause
		console.log('Paused:', this.paused)
	}

	release(): void {
		this.running = false
	}
}

export class FFmpegProducerFactory implements ProducerFactory<FFmpegProducer> {
	private clContext: nodenCLContext

	constructor(clContext: nodenCLContext) {
		this.clContext = clContext
	}

	createProducer(loadParams: LoadParams): FFmpegProducer {
		return new FFmpegProducer(loadParams, this.clContext)
	}
}
