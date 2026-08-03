/**
 * Verbatim `ffprobe` stdout, kept out of `probe.test.ts` so the tests there read as tests.
 *
 * Every constant below is exactly what `ffprobe 7.1.1 ${probeArgs(file)}` wrote, captured against
 * files that build produced. None of it is written from the documentation, which is the point: the
 * shapes that matter are the ones the tool actually emits, including the two that look like success.
 *
 * Nothing here is trimmed or tidied. The `side_data_list` blocks are noise the parser ignores, and the
 * last packet of `REORDERED_TS_SEGMENT` not carrying one is the tool's own inconsistency rather than a
 * transcription slip.
 */

/**
 * A live MPEG-TS segment as the bench publishes them: `-use_wallclock_as_timestamps 1 -copyts`, so
 * the timestamps are epoch-derived, and `-bf 3`, so **the packets are in decode order and the last
 * one listed is not the largest**.
 *
 * 15 packets at 90kHz, 3000 ticks apart. Its manifest declared `#EXTINF:0.500000`, which is 45000
 * ticks: `219000 - 177000 + 3000`. Reading the ends of the list instead gives 42000, one frame short.
 */
export const REORDERED_TS_SEGMENT = `{
    "packets": [
        {
            "pts": 177000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 189000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 183000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 180000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 186000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 201000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 195000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 192000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 198000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 213000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 207000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 204000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 210000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 219000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 216000
        }
    ],
    "programs": [
        {
            "streams": [
                {
                    "time_base": "1/90000"
                }
            ]
        }
    ],
    "stream_groups": [

    ],
    "streams": [
        {
            "time_base": "1/90000"
        }
    ],
    "format": {
        "format_name": "mpegts"
    }
}`;

/**
 * A fragmented MP4, which OME's low-latency packaging produces, probed with its `init.mp4` ahead of
 * it because a bare fragment carries no track header to read.
 *
 * Two things differ from the MPEG-TS above and both matter: the timescale is 15360 rather than 90000,
 * so reading 90kHz would be wrong by a factor of six, and `format_name` is the whole comma-separated
 * list of formats the demuxer answers to rather than one name. Also 15 packets and also reordered,
 * spanning `15862 - 8694 + 512`, which is 7680 ticks and the same half second.
 */
export const REORDERED_FMP4_SEGMENT = `{
    "packets": [
        {
            "pts": 8694
        },
        {
            "pts": 10742
        },
        {
            "pts": 9718
        },
        {
            "pts": 9206
        },
        {
            "pts": 10230
        },
        {
            "pts": 12790
        },
        {
            "pts": 11766
        },
        {
            "pts": 11254
        },
        {
            "pts": 12278
        },
        {
            "pts": 14838
        },
        {
            "pts": 13814
        },
        {
            "pts": 13302
        },
        {
            "pts": 14326
        },
        {
            "pts": 15862
        },
        {
            "pts": 15350
        }
    ],
    "programs": [

    ],
    "stream_groups": [

    ],
    "streams": [
        {
            "time_base": "1/15360"
        }
    ],
    "format": {
        "format_name": "mov,mp4,m4a,3gp,3g2,mj2"
    }
}`;

/**
 * What the probe used to return for every segment, back when it asked for one packet.
 *
 * Kept because it is now a refusal: one timestamp fixes when a frame started and nothing about how
 * long it lasted, so there is no span in it. A parser that quietly credited some default frame
 * duration here would report a measured span that nothing measured.
 */
export const SINGLE_PACKET_SEGMENT = `{
    "packets": [
        {
            "pts": 1932509272,
            "side_data_list": [
                {

                }
            ]
        }
    ],
    "programs": [
        {
            "streams": [
                {
                    "time_base": "1/90000"
                }
            ]
        }
    ],
    "stream_groups": [

    ],
    "streams": [
        {
            "time_base": "1/90000"
        }
    ],
    "format": {
        "format_name": "mpegts"
    }
}`;

/**
 * A segment that carries audio and no video. ffprobe exits **0** and reports empty arrays, so this is
 * the shape a reader mistakes for success: `packets[0].pts` is `undefined`, and every arithmetic step
 * after it yields NaN rather than throwing. A gateway serving the wrong bytes looks exactly like this.
 */
export const NO_VIDEO_SEGMENT = `{
    "packets": [

    ],
    "programs": [
        {
            "streams": [

            ]
        }
    ],
    "stream_groups": [

    ],
    "streams": [

    ],
    "format": {
        "format_name": "mpegts"
    }
}`;

/** What a truncated segment produces on stdout. ffprobe exits 1 and puts "End of file" on stderr. */
export const TRUNCATED_SEGMENT = `{

}`;

/**
 * An **open-GOP** MPEG-TS segment, where the first packet listed is not the earliest frame.
 *
 * The one shape the two fixtures above cannot produce. Both of those open on the keyframe that starts
 * their group, so their first listed packet is also their smallest timestamp, and an anchor that took
 * `packets[0]` instead of the minimum would agree with them on every segment.
 *
 * Here it does not. The list opens at 177000 and the earliest frame is 168000, because an open GOP
 * lets a segment begin with B-frames that reference the group before it, so those frames decode first
 * and display later. Taking the first listed packet puts the capture instant **100ms late**, which is
 * three frames at 30fps, and understates every latency figure in the run by that much, silently and
 * by the same amount on every segment.
 *
 * Captured with `-x264opts open-gop=1`. ffprobe writes decoder warnings to stderr for a segment whose
 * references sit in the previous one, which is what open GOP means rather than a broken capture, and
 * stdout below is unaffected.
 */
export const OPEN_GOP_TS_SEGMENT = `{
    "packets": [
        {
            "pts": 177000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 171000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 168000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 174000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 189000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 183000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 180000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 186000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 201000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 195000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 192000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 198000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 213000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 207000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 204000,
            "side_data_list": [
                {

                }
            ]
        },
        {
            "pts": 210000
        }
    ],
    "programs": [
        {
            "streams": [
                {
                    "time_base": "1/90000"
                }
            ]
        }
    ],
    "stream_groups": [

    ],
    "streams": [
        {
            "time_base": "1/90000"
        }
    ],
    "format": {
        "format_name": "mpegts"
    }
}`;
