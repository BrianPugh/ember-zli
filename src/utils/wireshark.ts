/**
 * @see https://github.com/wireshark/wireshark/blob/master/epan/dissectors/packet-zep.c
 * @see https://github.com/wireshark/wireshark/blob/master/epan/dissectors/packet-ieee802154.c
 * @see https://github.com/wireshark/wireshark/blob/master/epan/dissectors/packet-zbee-nwk.c
 *------------------------------------------------------------
 *
 *      ZEP Packets must be received in the following format:
 *      |UDP Header|  ZEP Header |IEEE 802.15.4 Packet|
 *      | 8 bytes  | 16/32 bytes |    <= 127 bytes    |
 *------------------------------------------------------------
 *
 *      ZEP v1 Header will have the following format:
 *      |Preamble|Version|Channel ID|Device ID|CRC/LQI Mode|LQI Val|Reserved|Length|
 *      |2 bytes |1 byte |  1 byte  | 2 bytes |   1 byte   |1 byte |7 bytes |1 byte|
 *
 *      ZEP v2 Header will have the following format (if type=1/Data):
 *      |Preamble|Version| Type |Channel ID|Device ID|CRC/LQI Mode|LQI Val|NTP Timestamp|Sequence#|Reserved|Length|
 *      |2 bytes |1 byte |1 byte|  1 byte  | 2 bytes |   1 byte   |1 byte |   8 bytes   | 4 bytes |10 bytes|1 byte|
 *
 *      ZEP v2 Header will have the following format (if type=2/Ack):
 *      |Preamble|Version| Type |Sequence#|
 *      |2 bytes |1 byte |1 byte| 4 bytes |
 *------------------------------------------------------------
 */
const PREAMBLE = 'EX'
const PROTOCOL_VERSION = 2
const PROTOCOL_TYPE = 1
/** Baseline NTP time if bit-0=0 -> 7-Feb-2036 @ 06:28:16 UTC */
const MSB_0_BASE_TIME = 2085978496000n
/** Baseline NTP time if bit-0=1 -> 1-Jan-1900 @ 01:00:00 UTC */
const MSB_1_BASE_TIME = -2208988800000n

const getZepTimestamp = (): bigint => {
    const now = BigInt(Date.now())
    const useBase1 = now < MSB_0_BASE_TIME // time < Feb-2036
    // MSB_1_BASE_TIME: dates <= Feb-2036, MSB_0_BASE_TIME: if base0 needed for dates >= Feb-2036
    const baseTime = now - (useBase1 ? MSB_1_BASE_TIME : MSB_0_BASE_TIME)
    let seconds = baseTime / 1000n
    const fraction = ((baseTime % 1000n) * 0x100000000n) / 1000n

    if (useBase1) {
        seconds |= 0x80000000n // set high-order bit if MSB_1_BASE_TIME 1900 used
    }

    return BigInt.asIntN(64, (seconds << 32n) | fraction)
}

export const createWiresharkZEPFrame = (
    channelId: number,
    deviceId: number,
    lqi: number,
    rssi: number,
    sequence: number,
    data: Buffer,
    lqiMode: boolean = false,
): Buffer => {
    const buffer = Buffer.alloc(167)
    let offset = 0

    // The IEEE 802.15.4 packet encapsulated in the ZEP frame must have the "TI CC24xx" format
    // See figure 21 on page 24 of the CC2420 datasheet: https://www.ti.com/lit/ds/symlink/cc2420.pdf
    // So, two bytes must be added at the end:
    // * First byte: RSSI value as a signed 8 bits integer (range -128 to 127)
    // * Second byte:
    //   - the most significant bit is set to 1 of the CRC of the frame is correct
    //   - the 7 least significant bits contain the LQI value as a unsigned 7 bits integer (range 0 to 127)
    data[data.length - 2] = rssi
    data[data.length - 1] = 0x80 | ((lqi >> 1) & 0x7f)

    // Protocol ID String | Character string | 2.0.3 to 4.2.5
    buffer.write(PREAMBLE, offset)
    offset += 2

    // Protocol Version | Unsigned integer (8 bits) | 1.2.0 to 4.2.5
    buffer.writeUInt8(PROTOCOL_VERSION, offset++)
    // Type | Unsigned integer (8 bits) | 1.2.0 to 1.8.15, 1.12.0 to 4.2.5
    buffer.writeUInt8(PROTOCOL_TYPE, offset++)
    // Channel ID | Unsigned integer (8 bits) | 1.2.0 to 4.2.5
    buffer.writeUInt8(channelId, offset++)
    // Device ID | Unsigned integer (16 bits) | 1.2.0 to 4.2.5
    buffer.writeUint16BE(deviceId, offset)
    offset += 2

    // LQI/CRC Mode | Boolean | 1.2.0 to 4.2.5
    buffer.writeUInt8(lqiMode ? 1 : 0, offset++)
    // Link Quality Indication | Unsigned integer (8 bits) | 1.2.0 to 4.2.5
    buffer.writeUInt8(lqi, offset++)

    // Timestamp | Date and time | 1.2.0 to 4.2.5
    buffer.writeBigInt64BE(getZepTimestamp(), offset)
    offset += 8

    // Sequence Number | Unsigned integer (32 bits) | 1.2.0 to 4.2.5
    buffer.writeUint32BE(sequence, offset)
    offset += 4

    // Reserved Fields | Byte sequence | 2.0.0 to 4.2.5
    offset += 10

    // Length | Unsigned integer (8 bits) | 1.2.0 to 4.2.5
    buffer.writeUInt8(data.length, offset++)

    buffer.set(data, offset)
    offset += data.length

    return buffer.subarray(0, offset) // increased to "beyond last" above
}
