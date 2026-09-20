import { createHash } from 'node:crypto';

import type { BoundedCommand } from './dockerCli.js';
import { FixtureRefusal } from './fixture.js';
import type { ReadinessControlExecutor } from './readinessSource.js';
import type {
  ContinuationTopology,
  ReadinessProbeId,
  TopologyServiceRole,
} from './topology.js';

const SAFE_CONTAINER_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const FIXTURE_ID = /^srs-continuation-20260920-[a-z0-9]{8,16}$/;
const POSTAGE_BATCH_ID = /^(?:0x)?[0-9a-fA-F]{64}$/;
const STREAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE = /^[0-9a-f]{64}$/;
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_CHILD_BYTES = 68 * 1024;
const CAPACITY_SAMPLE_MS = 250;
const INVALID_PUBLISH_KEY = 'readiness-invalid';

// Public deterministic fixtures generated from lavfi. They contain no deployment data or credential.
const BROWSER_MEDIA_BASE64 = 'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAZHbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAml0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAHhbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABjG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAUxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZCWwEQAAAAwBAAAADAgPEiZIBAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABVgAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAEAAAQAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAACRzdHN6AAAAAAAAAAAAAAAEAAACjgAAAAoAAAAKAAAACgAAACBzdGNvAAAAAAAAAAQAAAcQAAANdQAAEZUAABWiAAADCXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAIAAAAAAAAD6AAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAQAAAEAAAAAAoFtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAKxEAACwRFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAIsbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAHwc3RibAAAAH5zdHNkAAAAAAAAAAEAAABubXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAKxEAAAAAAA2ZXNkcwAAAAADgICAJQACAASAgIAXQBUAAAAAAH7dAAB+3QWAgIAFEghW5QAGgICAAQIAAAAUYnRydAAAAAAAAH7dAAB+3QAAACBzdHRzAAAAAAAAAAIAAAAsAAAEAAAAAAEAAABEAAAAKHN0c2MAAAAAAAAAAgAAAAEAAAABAAAAAQAAAAIAAAALAAAAAQAAAMhzdHN6AAAAAAAAAAAAAAAtAAAAmQAAAKEAAAA9AAAARgAAAE0AAABFAAAATgAAAGsAAABSAAAAXQAAAF0AAABcAAAAWgAAAF0AAAByAAAAVwAAAFAAAABsAAAAWQAAAFkAAABVAAAAXQAAAHYAAABSAAAAZwAAAFAAAABPAAAAYwAAAGIAAABnAAAAWgAAAFsAAAB9AAAATQAAAFQAAABMAAAAUwAAAHYAAABrAAAAVwAAAFgAAABPAAAAVwAAAIMAAAAFAAAAJHN0Y28AAAAAAAAABQAABncAAAmeAAANfwAAEZ8AABWsAAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAAC0AAAABAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMAAAAAhmcmVlAAAS7m1kYXTeAgBMYXZjNjEuMTkuMTAxAAJgpVSQ2nIy88ennjVecuWq6yRHlJIvzCQbdwPwXqvYu+4bLalpH+PS83ver8ngbUxVY2zWmvPrJSaaqmK5iqMmlLJSyWmlJoyUKUZKMlEmtDaG0MDGzYMDIkQMbNmzaJEilNmzcUUUUUUUUUUUUUUUSIooooookREREhEUURFFEiKKIoooouAAAAJwBgX//2zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgxOjB4MTExIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj00IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAFmWIhAS8RigACovHAAEo2OAAL60nXXgBOJTayV2UU6sp1ZLpz/Ptxps8av/61+/XGuNXr/+14/nzxrjV6//i9/588a61qw3+tjR9FBgLoEywhZ+p1m8pjbnAZzgMDO4TMDAzuEhIMDO4SEgwMDO7hISsGBgZ3cJCTkJsJd/hCrDdT5y5XpSt6UJvZm5QkqSzBpQkJJXgaUJCSV5wY3KEhJUlm4MDGwkJKscvENRRRQaiiijXuM3QbgE68osa1457/Z+/t8W6aaXqpcjjkkki6kDuf3zpuzZjZ/chk+DDP7gZPgwz+8I+Pgwz+4HD4Az+4GT4A4ABCDKR4p0Ih1as+f/p/H/r/1l8XrWTPj8/E+367du6SqgmCaabGD1eqaZc00y5spsJl2jY/n68xKY/Ncpm2/8p+HXLEGzgAQYyiiJ9CIdMIdEIdC29f/37//X73ONdbnVZ6+s7+Md+ytVWmLHNPOc6innVPPOedQnnOqLmqb6XHnzp+V4BzxZJ4plAsMRWyzVCsXABCjKSAo0Ih1as9//r+f/X/e741cuuO/X3r5/fbt8TJeKvLwA0suHfev1yyyyyyymzZvGXGVVqr1iU01U0pkPbQ7fUBfgBBDKIljGekEOmZXv/07/x/ma4u731OfX33z8VzTvo6FQEvMdU5TFzUeXhr16/y1y1tbPNu7VyrZYDZnX2th26NXfT95ZYKLIi5BN0y8ABDDKQljKehEOhEOiEWhIOhHv/f5/8vver1Liol/p++DsyuDcACQkJjUZ9HxBdoAfT6fT6UfT6fSiDXA95wXtwUHzhiVhsbwoBtjZPG7TpYsPdB4zAfyxii0KwbvkUs4F7601axqd9JkHY3wD8MqTogV6ERahznf/17/0/6y+JxNVvr+P15zpXh6X1GSZeBExMNKvbPrMbAYemPTTLwrJBF8M52jS228SX0J2nqOqU3fxMsCNQVFhu3/JfW4ABCjKQljKOiEOiEWhEOkHr/44/n8S+Lksv8/fX7f47dmXURsgAwMDQMu+iZyOOah8p+b5fL5TzjmqylzEQ5rkkAdGytXAMAVD5EooQMTkaIVnawb59at9ntboL14ABBDKQljJQn0Jj0Qh0gh0Ldc/2/T/283Or4lq738VWsd+/KpmXVXAbll95byGGWgvP6IRRFFFEIhFVDCUiIilynIvZ6iiXZ3wUkCiNqYp68dnz4iMVXwqavxiwT4ABCDKIljKOhEOhEOhEOkEOiVXv+3j/zS+OF1qPt97/T9cd2TmvZRkg53nk8hrmlKA2SQ1555555555Lq0pN27mPQGASHzMcCgCS9QzFCGfSImLCNYsJLtOffgZ+AAAAAZBmjgJeWABCDKIljRAp0Ij0wh0IhVnz9vz/98u+NXwo9/pvjHb4+qqYikH0ooQs/6ZYNNLUYXNNNNNNNM0Vaah2Jo4ZQJWJ/R5zot0d5pAsnTRmcYJWfxLyM0aI/ObjLgBBDKIdkGuhEOkEOibp/47/583euF+a53z9T3+DJ4ePm8ikE86jE0IkyIRABZj0N+/fv3/hvpe9Hel771aXKW9sMnkYwny/n78NNd9MV5XHr6wyFRUK3TJcZ3kJcABCjKQljRAp0In0Ij0KnP/xn/Pxd61LK18/eeOjs9e1SVWTLAGBgbzEXH1FmbfvQBjZsGNmwY2DSqBsa0rRizxKLw9tnqKOdK9JvzBelawuRbSOvbOl+K9K2nbfcvX3Ib/aSYqW6siddtSclHJSuBLNPgA+jKkxMFGmEOiEOhd19v/w7/X/zvWtazUzX7fd37VPd6Y1WeZUBnWeEsb9v+pSb9/v9/vH98sXCTElKDIKqCAx1Y8T2EXFsvsS0kfAC7SRT2TzvM33twBDDKQljRIo0Yi1BPf/4n/P1L1d2knfmvt+u3ZUrQogBISExs+xbEAqR4ASEhISJCSpWYqs40luvhN87nSctlv5Lktm2b1xpJBUyad2HLE4AEEMpCWMomTRkHRCNuuf+Pf/y9pfHF8ZN6+34zn2yVNvHVXQCaabzkn3SXRvH6AUUUUULooX69VC66DJMvyMAuFAU+OQBG9tGlqMWcKzakLfRrRvrw1TRyWF1r7leSh6L3lLKoPQpCulDFEpwEIMoiWMo6EQ6EQ6NQ6Vlev65/vq741eqSvt+Nft/O3dUVKuoUPlPOfGTtGwdDG2wnnnnnnnnPzIJ86vkDqBAHUpUWkMAPKqFl/zXJ0gMyLLRgatYs5xCOAAQgykJYyWKNCIdCIdEIdIyt/29//a7nHGmqy/n8c50cu3K9oyqgG5ZfeVvFqHbf+FGVFEUUXGKLm+UWWYER3znuYo6TE2Dmhp8tXeDzNIMYqIysqaqFFmngBBjKUljJYm0Ih0Ih04h0LdV/f5/6+ZOrvitTfv98+387d3h1l1SAZtdHfkef6/1ZM+geeY8x5jGMvSx7a0ZP0kiSZDquS5d9T+kekgTQeVh1CKUb8AQoykJYyiItMIdEIlOf/Ff6feavVzWdc/P6u+snLtJTplQBISc89D07WDnxtgUUa9dG7XA3BRu1rN2hd7pAfTEGU+yILrMl5nSxLs0n3RHCpSeOvUfta0JdqLbEnAPoyiHZCUK9CQtCJNC7d/+nf/X6vWuJLVvn4r7frkPT2+sqoqCef1BMoSYWsQKu2B+v1+v1HP1NTmVOgR/qxOlyjJB3TGL9V+c+d9neGnZvqPZOFZfEKi5DyH/BTwXUy4ujyehA1Y98utK4ybwSmlsstdl0T4AAAAAZBmlQCPlgBDDKQljJok0Ih0Ih1I9f8eP9/1u9cJdanv7OesdVVKvFSoAMDA0ClJw/Fz81D5fL5fL5fKebLVUrm4zVdyCsbAn38XHE9RnOyiEpRLZOMXlHAAP4yiHZCjoRFoRFohDoiDoXdd/9vX/P4l8cXxkP0/x36/Wnn9vbJd1kQEIiA6j8nlYDzoIRRRRRRFEHORREVJBCSAgQ0FWBQAn6I6dXuv7gv7UiCWK1vsV+196fWWsu04UCgnHVR8AEKMoh2Qo6ER6lTP/2r/r7XfGrayTvy79tu3NeIqoqUOd54EbP6z24IqA888889z86edjL3oIFm56+sBK0rScVAYMw6x46A6iW0ywtmCIqOAQgyiJYxlohDpBDpFZ8+v0/39prV6aVPX355+KO5lXVSKgoooQ2KAJarb9+MGzZs2bNi3qjH+XRHgJYRltGcmMZe0bsFZXRTQeVI/qQXtwEEMoh2QY6ER6MhaERaFus/47/29petcTOLr9vw9/vt4LxMuTN0PlOoEUkShLukaVVDfv3773vvvvvvU1S3w03gUXu/dMzqc09SSZbGhWsVDxkNwCR96AkyeEVRJqSs0bgIuAEKMpCWMlCvQiTSKrf/Hj/21Ncakmtu/LnyePPu7fvVFIAZFL5ia0gTOht8KAqKKLLFFxihfhiR8oZiXpcVovJ7BKhLVSdUIaJBj+UN5AVCt9PlU6SdbFNSG217aHPOlAycAQIyiHZCQLdGIdCI9Cyt/+O/+/td3xNXW+a+ufn+eVWeCsaqgeeeBK35/bdw1bUwfv9/vSx5Ke9jnazk1yJYSWfIbVylqa0/ySjJPqmU4ErTazy0eSoU5Oz12nP5XrGHcn+5KCmiHAEMMpCWJGCbQmPSCHSD1/4r8f7XetSWT7fje/jHVvjN3VJUAJCQmND0LWAVT1BIScCRIkrNTK5YFYWsKiXCaBa+1OTUYZN0PXOUpwG53C7Y4DR85nNTgyltPAD+Moh2QpaIQ6MQ6MQ6Fznf/Hr9/9161qLx6/Hfz/OY9L2paZcFC6APMFaFoEiq8B+uiiiiiihVC4BRfzgUHjAPQ0wLDAErxaZj4HktOd6kVJ2QKbmq0puN48ABCjKQljJxt0IiU7/8P8ffU41rhtPHtnPxTvrJqqy3coAxIlA9TsPO4Ft5Ceefmn+Xy+T/y5n+L8858okbAfXOSpG0VcOz225XvSaHIkGlON5RzQaOsF95JuKs9K7RyZTr3quucqt+Kl+VK5lXbNpcN46mYpP+yGGuklBJwAEEMpJCbQiHQiHUt59v/H8f+v+bvjWrrVX+3+M/T9ad/KZKLoCKWXD/H6/XLLLLLLLLnLLKisr4so8kEDrCzV81yj31v777qoC4ymzgAAAABkGaYBDywAEGMoiWMo6EQ6EQ6cQ6Ft7/t4/66u+L4rVL9fXO/bbu2yrykzqx9Hnk8hrujJw0R4HnnnnnnvN54J8+d4yVveMYG79rDJBxAeYlu56MCgaRUKLEXAEKMoiWMo6MQ6lVfP6fn/7ya1xNSZnPxXz+uOw3l5UioPpRQhLdIJYC8WoUuiiiiiiijXu+msc96UhiWwDG3KF4YAk1jZkwQC0FCPABAjKIljJZo0Ii1Db3/6P9/pOOs6Z0/r+/O/ZVPDx8KpKWJ5531CUCkShcNWh+p551TnUrUI5p1TLt7t0DWx1Vu0BJHHTbjXFbMbAv9aLDdf5UHAEKMpCWMo6ER6ERaEhaEg6Er1/05/2/eXrVxrdc/evf6p2c9c5qqS6oAwMDQIupqDAr38Pl8uPy4/Ljli5jzP5Z+OUIfjAqJfH2IKAnfnr5W1zQ0DHjZ6f0IvTSmlpnOZKDHkve2c/0FRgxbyKlodIBCyJ+4uAA/DKQljQou0Ii0Jk0be+//Hf+/6zV8S6krx9c+PvWdvLq6qVe7DFHL5qnP4qKGraCAGZAzLgbGacHgV4wpSssJr+906rkrUvP64b2jWgCaLeT5dhK4z1bPZYtVLH/SVIsnHrJZYuxpqzxcAEKMpCWNEijQiHQiHRCHTKev+2//L4l61NS96/T649/rbr7reX7YgASEiY2c6g7wOR4ASVCQkqEiSttS0qVCRPSctHCAWn5rMZrpT8e/2isCYsB5S2zgAECMqTjPQiHQiLTOa+f6/2/3/3uccXedPG/vv5/XK28LXWJUoZRMTCeJ/5HlY2NmzZsbNmxaMXj9mzoU0H7RjFyTNuvjmU9c7RttSBZBnMMIGGtYCVWqvABCDKIljJYo0Yh07Hv/xP/Or1fDVxXj4rx7Y27OZwJUDZPOd644STxo1syeeeeeeec882yp9/eDqxmQ8lk8jYNv4Qn5FVaQvqBkhW88abgATpSkxpRDohDoSDolVP+Pz/vxrry4cVpd2kcUi/aReroB4eHt2LDw8PPrAABhx4etwAAU4eHrcAAFOHh7bgAApw8PW4AAKcPD/8Xf0+p8h+4Rg5fYhJwATiVpssk4sxRlEtrDtx+M4vrV6//s3+vAXr/y/sFtmaEk4cd4QElYfcf4SkrT1TUvelK3pQm88qgnK9mDShITevAwMEhJKxwaVQSEnB17MGBpQkJKscvCyi/L5uN582vtHzbfIOanIOZzsKSIj+eo1fmPy16x6tmzsXKed5555798uABGIG0cA==';
const MPEG_TS_BASE64 = 'R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////0dQABAAArASAAHBAADhAPAAG+EA8AAVvU1W////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAAAB4AAAgIAFIQAH2GEAAAABCfAAAAABZ0LACtkJbARAAAADAEAAAAMAg8SJkgAAAAFoy4PLIAAAAQYF//9s3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEwOCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3cudmlkZW9sYW5HAQARLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMUcBABIxIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50RwEAMxQA/////////////////////////19taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAWWIhAV8RigADqDHAAGwaOAAI0MnXXg=';

export interface ReadinessContainerBinding {
  id: string;
  name: string;
}

export interface FixtureReadinessControlInput {
  fixtureId: string;
  topology: ContinuationTopology;
  containers: ReadonlyMap<TopologyServiceRole, ReadinessContainerBinding>;
  postageBatchId: string;
  viewerMediaBaseUrl: string;
  srs: { host: string; rtmpPort: number };
  readinessStreamId: string;
  requiredDiskBytes: number;
  controlTimeoutMs?: number;
}

export interface ReadinessControlClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: ReadinessControlClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface ControlResult {
  [key: string]: unknown;
}

interface CapacityInspection {
  state: string;
  nanoCpus: number;
  memoryBytes: number;
  pidsLimit: number;
}

interface CgroupReading {
  memoryCurrentBytes: number;
  pidsCurrent: number;
  nrThrottled: number;
}

/** Runs each destructive-readiness assertion inside an exact journal-owned fixture container. */
export class FixtureReadinessControlExecutor implements ReadinessControlExecutor {
  private readonly timeoutMs: number;
  private browserMediaReference: string | undefined;
  private timeoutsWithinBounds = true;

  constructor(
    private readonly command: BoundedCommand,
    private readonly input: FixtureReadinessControlInput,
    private readonly clock: ReadinessControlClock = SYSTEM_CLOCK,
  ) {
    validateInput(input);
    this.timeoutMs = input.controlTimeoutMs ?? 30_000;
  }

  async run(probeId: ReadinessProbeId, maxResponseBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_CONTROL_BYTES) {
      throw new FixtureRefusal('readiness control response bound is invalid');
    }
    const startedAt = this.clock.now();
    let result: ControlResult;
    switch (probeId) {
      case 'storage':
        result = await this.storage(maxResponseBytes);
        break;
      case 'callbacks':
        result = await this.callbacks(maxResponseBytes);
        break;
      case 'openingFormat':
        result = await this.openingFormat(maxResponseBytes);
        break;
      case 'browserDecode':
        result = await this.browserDecode(maxResponseBytes);
        break;
      case 'falseCodec':
        result = await this.falseCodec(maxResponseBytes);
        break;
      case 'capacity':
        result = await this.capacity();
        break;
      default:
        throw new FixtureRefusal(`${probeId} is not a readiness control`);
    }
    this.timeoutsWithinBounds &&= this.clock.now() - startedAt <= this.timeoutMs;
    if (probeId === 'capacity') {
      result.timeoutsWithinBounds = this.timeoutsWithinBounds;
    }
    return encodedResult(result, maxResponseBytes);
  }

  private async storage(maxResponseBytes: number): Promise<ControlResult> {
    const raw = await this.nodeControl(
      'uploader',
      STORAGE_CONTROL_SCRIPT,
      { viewerBaseUrl: this.input.viewerMediaBaseUrl, sample: BROWSER_MEDIA_BASE64 },
      maxResponseBytes,
    );
    const expectedBatchHash = `sha256:${createHash('sha256').update(normalizedBatchId(this.input.postageBatchId)).digest('hex')}`;
    const reference = stringField(raw, 'browserMediaReference');
    const result = {
      source: exactString(raw, 'source', 'bee-upload-read-control'),
      batchIdHash: exactString(raw, 'batchIdHash', expectedBatchHash),
      usable: booleanField(raw, 'usable'),
      capacityBytes: nonNegativeInteger(raw, 'capacityBytes'),
      ttlSeconds: nonNegativeInteger(raw, 'ttlSeconds'),
      uploadStatus: integer(raw, 'uploadStatus'),
      readStatus: integer(raw, 'readStatus'),
      bytesMatch: booleanField(raw, 'bytesMatch'),
    };
    if (
      !REFERENCE.test(reference) ||
      result.uploadStatus !== 201 ||
      result.readStatus !== 200 ||
      result.bytesMatch !== true
    ) {
      throw new FixtureRefusal('storage control did not prove the fixture upload and viewer read');
    }
    this.browserMediaReference = reference;
    return result;
  }

  private async callbacks(maxResponseBytes: number): Promise<ControlResult> {
    const raw = await this.nodeControl(
      'uploader',
      CALLBACK_CONTROL_SCRIPT,
      {
        host: this.input.srs.host,
        port: this.input.srs.rtmpPort,
        streamId: this.input.readinessStreamId,
        invalidKey: INVALID_PUBLISH_KEY,
      },
      maxResponseBytes,
    );
    const result = {
      source: exactString(raw, 'source', 'srs-callback-control'),
      callbacksBefore: nonNegativeInteger(raw, 'callbacksBefore'),
      callbacksAfter: nonNegativeInteger(raw, 'callbacksAfter'),
    };
    if (result.callbacksAfter !== result.callbacksBefore + 1) {
      throw new FixtureRefusal('callback control did not observe exactly one rejection from the real SRS attempt');
    }
    return result;
  }

  private async openingFormat(maxResponseBytes: number): Promise<ControlResult> {
    const raw = await this.nodeControl(
      'uploader',
      OPENING_FORMAT_CONTROL_SCRIPT,
      { sample: MPEG_TS_BASE64 },
      maxResponseBytes,
    );
    return {
      source: exactString(raw, 'source', 'ffprobe'),
      exitCode: integer(raw, 'exitCode'),
      formatName: stringField(raw, 'formatName'),
    };
  }

  private async browserDecode(maxResponseBytes: number): Promise<ControlResult> {
    if (!this.browserMediaReference) {
      throw new FixtureRefusal('browser readiness requires a verified storage control');
    }
    const raw = await this.nodeControl(
      'browser',
      BROWSER_CONTROL_SCRIPT,
      {
        mode: 'decode',
        mediaUrl: `${this.input.viewerMediaBaseUrl}/bee/bytes/${this.browserMediaReference}`,
      },
      maxResponseBytes,
    );
    const codecs = stringArray(raw, 'codecs');
    const result = {
      source: exactString(raw, 'source', 'browser-media-control'),
      playEvent: booleanField(raw, 'playEvent'),
      decodedFramesBefore: nonNegativeInteger(raw, 'decodedFramesBefore'),
      decodedFramesAfter: nonNegativeInteger(raw, 'decodedFramesAfter'),
      decodedAudioBytesBefore: nonNegativeInteger(raw, 'decodedAudioBytesBefore'),
      decodedAudioBytesAfter: nonNegativeInteger(raw, 'decodedAudioBytesAfter'),
      currentTimeBefore: nonNegativeNumber(raw, 'currentTimeBefore'),
      currentTimeAfter: nonNegativeNumber(raw, 'currentTimeAfter'),
      codecs,
    };
    if (
      !result.playEvent ||
      result.decodedFramesAfter <= result.decodedFramesBefore ||
      result.decodedAudioBytesAfter <= result.decodedAudioBytesBefore ||
      result.currentTimeAfter <= result.currentTimeBefore ||
      !codecs.includes('avc1.42c00a') ||
      !codecs.includes('mp4a.40.2')
    ) {
      throw new FixtureRefusal('browser control did not prove video and audio decoding through the viewer');
    }
    return result;
  }

  private async falseCodec(maxResponseBytes: number): Promise<ControlResult> {
    const raw = await this.nodeControl(
      'browser',
      BROWSER_CONTROL_SCRIPT,
      { mode: 'false-codec' },
      maxResponseBytes,
    );
    const result = {
      source: exactString(raw, 'source', 'browser-false-codec-control'),
      attemptedCodec: stringField(raw, 'attemptedCodec'),
      supported: booleanField(raw, 'supported'),
      sourceBufferAccepted: booleanField(raw, 'sourceBufferAccepted'),
      loadedMetadata: booleanField(raw, 'loadedMetadata'),
    };
    if (result.supported || result.sourceBufferAccepted || result.loadedMetadata) {
      throw new FixtureRefusal('false codec control did not observe a browser refusal');
    }
    return result;
  }

  private async capacity(): Promise<ControlResult> {
    const inspected = new Map<TopologyServiceRole, CapacityInspection>();
    const first = new Map<TopologyServiceRole, CgroupReading>();
    let diskContainer: string | undefined;
    let availableDiskBytes = Number.MAX_SAFE_INTEGER;

    for (const service of this.input.topology.services) {
      const binding = this.binding(service.role);
      const inspection = await this.capacityInspection(binding.id);
      inspected.set(service.role, inspection);
      if (inspection.state === 'running') {
        diskContainer ??= binding.id;
        first.set(service.role, await this.cgroup(binding.id));
        availableDiskBytes = Math.min(availableDiskBytes, await this.availableDisk(binding.id));
      }
    }
    if (!diskContainer || availableDiskBytes === Number.MAX_SAFE_INTEGER) {
      throw new FixtureRefusal('capacity control found no running fixture container');
    }
    await this.clock.sleep(CAPACITY_SAMPLE_MS);

    const services = [];
    for (const service of this.input.topology.services) {
      const inspection = inspected.get(service.role);
      if (!inspection) {
        throw new FixtureRefusal('capacity control lost a container inspection');
      }
      const binding = this.binding(service.role);
      const earlier = first.get(service.role);
      const current = inspection.state === 'running'
        ? await this.cgroup(binding.id)
        : { memoryCurrentBytes: 0, pidsCurrent: 0, nrThrottled: 0 };
      services.push({
        role: service.role,
        memoryCurrentBytes: current.memoryCurrentBytes,
        memoryLimitBytes: inspection.memoryBytes,
        pidsCurrent: current.pidsCurrent,
        pidsLimit: inspection.pidsLimit,
        cpuLimit: inspection.nanoCpus / 1_000_000_000,
        cpuThrottledDelta: earlier ? current.nrThrottled - earlier.nrThrottled : 0,
      });
    }
    return {
      source: 'fixture-capacity-control',
      availableDiskBytes,
      requiredDiskBytes: this.input.requiredDiskBytes,
      timeoutsWithinBounds: this.timeoutsWithinBounds,
      services,
    };
  }

  private async nodeControl(
    role: TopologyServiceRole,
    script: string,
    value: Record<string, unknown>,
    maxResponseBytes: number,
  ): Promise<Record<string, unknown>> {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64');
    const result = await this.command.run('docker', [
      'exec',
      this.binding(role).id,
      'node',
      '-e',
      script,
      payload,
    ]);
    return parsedObject(result.stdout, Math.min(MAX_CHILD_BYTES, maxResponseBytes + 4_096));
  }

  private binding(role: TopologyServiceRole): ReadinessContainerBinding {
    const binding = this.input.containers.get(role);
    if (!binding || !SAFE_CONTAINER_ID.test(binding.id)) {
      throw new FixtureRefusal(`${role} readiness container binding is missing`);
    }
    return binding;
  }

  private async capacityInspection(id: string): Promise<CapacityInspection> {
    const result = await this.command.run('docker', [
      'container',
      'inspect',
      '--format',
      '{"state":{{json .State.Status}},"nanoCpus":{{json .HostConfig.NanoCpus}},"memoryBytes":{{json .HostConfig.Memory}},"pidsLimit":{{json .HostConfig.PidsLimit}}}',
      id,
    ]);
    const value = parsedObject(result.stdout, 4_096);
    const inspection = {
      state: stringField(value, 'state'),
      nanoCpus: positiveInteger(value, 'nanoCpus'),
      memoryBytes: positiveInteger(value, 'memoryBytes'),
      pidsLimit: positiveInteger(value, 'pidsLimit'),
    };
    if (!['created', 'running', 'exited'].includes(inspection.state)) {
      throw new FixtureRefusal('capacity control container state is malformed');
    }
    return inspection;
  }

  private async cgroup(id: string): Promise<CgroupReading> {
    const result = await this.command.run('docker', [
      'exec',
      id,
      '/bin/sh',
      '-c',
      'cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/pids.current; cat /sys/fs/cgroup/cpu.stat',
    ]);
    const lines = result.stdout.trim().split(/\r?\n/);
    const memoryCurrentBytes = numericLine(lines[0]);
    const pidsCurrent = numericLine(lines[1]);
    const throttled = lines.slice(2).find((line) => line.startsWith('nr_throttled '));
    if (!throttled) {
      throw new FixtureRefusal('capacity control cgroup reading is malformed');
    }
    return { memoryCurrentBytes, pidsCurrent, nrThrottled: numericLine(throttled.slice('nr_throttled '.length)) };
  }

  private async availableDisk(id: string): Promise<number> {
    const result = await this.command.run('docker', ['exec', id, 'df', '-Pk', '/']);
    const lines = result.stdout.trim().split(/\r?\n/);
    const columns = lines.at(-1)?.trim().split(/\s+/) ?? [];
    if (columns.length < 4) {
      throw new FixtureRefusal('capacity control disk reading is malformed');
    }
    const kibibytes = numericLine(columns[3]);
    const bytes = kibibytes * 1_024;
    if (!Number.isSafeInteger(bytes)) {
      throw new FixtureRefusal('capacity control disk reading is malformed');
    }
    return bytes;
  }
}

function validateInput(input: FixtureReadinessControlInput): void {
  if (
    !FIXTURE_ID.test(input.fixtureId) ||
    input.topology.fixtureId !== input.fixtureId ||
    input.topology.network === '' ||
    !POSTAGE_BATCH_ID.test(input.postageBatchId) ||
    !STREAM_ID.test(input.readinessStreamId) ||
    !/^[A-Za-z0-9_.-]{1,200}$/.test(input.srs.host) ||
    !Number.isSafeInteger(input.srs.rtmpPort) ||
    input.srs.rtmpPort < 1 ||
    input.srs.rtmpPort > 65_535 ||
    !Number.isSafeInteger(input.requiredDiskBytes) ||
    input.requiredDiskBytes < 1 ||
    !Number.isSafeInteger(input.controlTimeoutMs ?? 30_000) ||
    (input.controlTimeoutMs ?? 30_000) < 1 ||
    (input.controlTimeoutMs ?? 30_000) > 30_000
  ) {
    throw new FixtureRefusal('readiness control input is malformed');
  }
  let viewer: URL;
  try {
    viewer = new URL(input.viewerMediaBaseUrl);
  } catch {
    throw new FixtureRefusal('readiness viewer media URL is malformed');
  }
  if (
    viewer.protocol !== 'http:' ||
    viewer.username !== '' ||
    viewer.password !== '' ||
    viewer.search !== '' ||
    viewer.hash !== '' ||
    viewer.pathname !== '/' ||
    viewer.port !== ''
  ) {
    throw new FixtureRefusal('readiness viewer media URL is malformed');
  }
  if (viewer.hostname !== 'client') {
    throw new FixtureRefusal('readiness viewer media URL does not match the topology');
  }
  const srsService = input.topology.services.find(({ role }) => role === 'srs');
  const rtmpPort = srsService?.ports.find(({ name, protocol }) => name === 'rtmp' && protocol === 'tcp');
  if (input.srs.host !== 'srs' || rtmpPort?.containerPort !== input.srs.rtmpPort) {
    throw new FixtureRefusal('readiness SRS endpoint does not match the topology');
  }
  const boundIds = new Set<string>();
  for (const service of input.topology.services) {
    const binding = input.containers.get(service.role);
    if (
      !binding ||
      !SAFE_CONTAINER_ID.test(binding.id) ||
      !SAFE_CONTAINER_ID.test(binding.name) ||
      boundIds.has(binding.id)
    ) {
      throw new FixtureRefusal(`${service.role} readiness container binding does not match the topology`);
    }
    boundIds.add(binding.id);
  }
}

function normalizedBatchId(value: string): string {
  return value.toLowerCase().replace(/^0x/, '');
}

function parsedObject(raw: string, maximumBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(raw) > maximumBytes) {
    throw new FixtureRefusal('readiness control did not return bounded JSON');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FixtureRefusal('readiness control did not return bounded JSON');
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new FixtureRefusal('readiness control did not return bounded JSON');
}

function encodedResult(value: ControlResult, maximumBytes: number): Uint8Array {
  const result = Buffer.from(JSON.stringify(value));
  if (result.byteLength > maximumBytes) {
    throw new FixtureRefusal('readiness control result exceeded its byte bound');
  }
  return result;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const found = value[field];
  if (typeof found !== 'string' || found.length < 1 || found.length > 1_024) {
    throw new FixtureRefusal('readiness control observation is malformed');
  }
  return found;
}

function exactString(value: Record<string, unknown>, field: string, expected: string): string {
  const found = stringField(value, field);
  if (found !== expected) {
    throw new FixtureRefusal('readiness control observation identity does not match');
  }
  return found;
}

function booleanField(value: Record<string, unknown>, field: string): boolean {
  const found = value[field];
  if (typeof found !== 'boolean') {
    throw new FixtureRefusal('readiness control observation is malformed');
  }
  return found;
}

function integer(value: Record<string, unknown>, field: string): number {
  const found = value[field];
  if (!Number.isSafeInteger(found)) {
    throw new FixtureRefusal('readiness control observation is malformed');
  }
  return found as number;
}

function nonNegativeInteger(value: Record<string, unknown>, field: string): number {
  const found = integer(value, field);
  if (found < 0) {
    throw new FixtureRefusal('readiness control observation is malformed');
  }
  return found;
}

function positiveInteger(value: Record<string, unknown>, field: string): number {
  const found = integer(value, field);
  if (found < 1) {
    throw new FixtureRefusal('readiness control observation is malformed');
  }
  return found;
}

function nonNegativeNumber(value: Record<string, unknown>, field: string): number {
  const found = value[field];
  if (typeof found !== 'number' || !Number.isFinite(found) || found < 0) {
    throw new FixtureRefusal('readiness control observation is malformed');
  }
  return found;
}

function stringArray(value: Record<string, unknown>, field: string): string[] {
  const found = value[field];
  if (
    !Array.isArray(found) ||
    found.length < 1 ||
    found.length > 16 ||
    found.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 200)
  ) {
    throw new FixtureRefusal('readiness control observation is malformed');
  }
  return found as string[];
}

function numericLine(value: string | undefined): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new FixtureRefusal('capacity control numeric reading is malformed');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new FixtureRefusal('capacity control numeric reading is malformed');
  }
  return parsed;
}

const STORAGE_CONTROL_SCRIPT = String.raw`
const { createHash, timingSafeEqual } = require('node:crypto');
const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const bee = process.env.BEE_URL;
const batch = String(process.env.STAMP || '').toLowerCase().replace(/^0x/, '');
if (!/^https?:\/\/.+/.test(bee || '') || !/^[0-9a-f]{64}$/.test(batch)) process.exit(2);
const sample = Buffer.from(input.sample, 'base64');
(async () => {
  const stampResponse = await fetch(bee + '/stamps/' + batch, { signal: AbortSignal.timeout(5000) });
  const stamp = await stampResponse.json();
  const upload = await fetch(bee + '/bytes', {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'video/mp4', 'swarm-postage-batch-id': batch },
    body: sample,
  });
  const uploaded = await upload.json();
  const reference = typeof uploaded.reference === 'string' ? uploaded.reference : '';
  const read = await fetch(input.viewerBaseUrl + '/bee/bytes/' + reference, {
    signal: AbortSignal.timeout(5000),
  });
  const bytes = Buffer.from(await read.arrayBuffer());
  const depth = Number(stamp.depth);
  const capacityBytes = 4096 * 2 ** depth;
  const batchId = String(stamp.batchID || stamp.batchId || '').toLowerCase().replace(/^0x/, '');
  const same = bytes.length === sample.length && timingSafeEqual(bytes, sample);
  process.stdout.write(JSON.stringify({
    source: 'bee-upload-read-control',
    batchIdHash: 'sha256:' + createHash('sha256').update(batchId).digest('hex'),
    usable: stampResponse.status === 200 && stamp.usable === true && stamp.exists !== false,
    capacityBytes,
    ttlSeconds: Number(stamp.batchTTL),
    uploadStatus: upload.status,
    readStatus: read.status,
    bytesMatch: same,
    browserMediaReference: reference,
  }));
})().catch(() => process.exit(3));
`;

const CALLBACK_CONTROL_SCRIPT = String.raw`
const { spawnSync } = require('node:child_process');
const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const token = process.env.API_AUTH_TOKEN;
const port = process.env.API_PORT;
if (!token || !/^\d+$/.test(port || '')) process.exit(2);
const metric = async () => {
  const response = await fetch('http://127.0.0.1:' + port + '/metrics', {
    signal: AbortSignal.timeout(3000),
    headers: { authorization: 'Bearer ' + token },
  });
  const body = await response.text();
  const match = /^swarm_hls_auth_rejections_total ([0-9]+)$/m.exec(body);
  if (!response.ok || !match) throw new Error('metric');
  return Number(match[1]);
};
(async () => {
  const before = await metric();
  const target = 'rtmp://' + input.host + ':' + input.port + '/live/' + input.streamId + '?key=' + input.invalidKey;
  spawnSync('/usr/bin/ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=2',
    '-t', '0.5', '-an', '-c:v', 'libx264', '-f', 'flv', target,
  ], { encoding: 'utf8', timeout: 5000, maxBuffer: 32768 });
  let after = before;
  for (let attempt = 0; attempt < 20 && after === before; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = await metric();
  }
  process.stdout.write(JSON.stringify({
    source: 'srs-callback-control',
    callbacksBefore: before,
    callbacksAfter: after,
  }));
})().catch(() => process.exit(3));
`;

const OPENING_FORMAT_CONTROL_SCRIPT = String.raw`
const { spawnSync } = require('node:child_process');
const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const result = spawnSync('/usr/bin/ffprobe', [
  '-v', 'error', '-f', 'mpegts', '-show_entries', 'format=format_name', '-of', 'json', 'pipe:0',
], {
  input: Buffer.from(input.sample, 'base64'),
  encoding: 'utf8',
  timeout: 5000,
  maxBuffer: 32768,
});
let formatName = '';
try {
  const parsed = JSON.parse(result.stdout || '{}');
  formatName = String(parsed.format && parsed.format.format_name || '').split(',').includes('mpegts') ? 'mpegts' : '';
} catch {}
process.stdout.write(JSON.stringify({ source: 'ffprobe', exitCode: result.status ?? -1, formatName }));
`;

export const BROWSER_CONTROL_SCRIPT = String.raw`
const { spawnSync } = require('node:child_process');
const input = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
const falseCodec = 'video/mp4; codecs="definitely-not-a-codec"';
const quotedMediaUrl = JSON.stringify(input.mediaUrl);
const program = input.mode === 'decode'
  ? "(async()=>{const v=document.createElement('video');v.muted=true;v.autoplay=true;v.src=" + quotedMediaUrl + ";document.body.append(v);let played=false;v.addEventListener('play',()=>{played=true},{once:true});const frameBefore=v.webkitDecodedFrameCount||0;const audioBefore=v.webkitAudioDecodedByteCount||0;const timeBefore=v.currentTime;try{await v.play()}catch{}await new Promise(r=>setTimeout(r,2500));const supported=['avc1.42c00a','mp4a.40.2'].filter(c=>MediaSource.isTypeSupported('video/mp4; codecs=\\\"'+c+'\\\"'));document.body.textContent=JSON.stringify({source:'browser-media-control',playEvent:played,decodedFramesBefore:frameBefore,decodedFramesAfter:v.webkitDecodedFrameCount||0,decodedAudioBytesBefore:audioBefore,decodedAudioBytesAfter:v.webkitAudioDecodedByteCount||0,currentTimeBefore:timeBefore,currentTimeAfter:v.currentTime,codecs:supported})})()"
  : "(async()=>{const attemptedCodec=" + JSON.stringify(falseCodec) + ";let loaded=false;let sourceBufferAccepted=false;const v=document.createElement('video');v.addEventListener('loadedmetadata',()=>{loaded=true},{once:true});const supported=MediaSource.isTypeSupported(attemptedCodec)||v.canPlayType(attemptedCodec)!=='';try{const media=new MediaSource();v.src=URL.createObjectURL(media);const opened=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),1000);media.addEventListener('sourceopen',()=>{clearTimeout(timer);resolve(true)},{once:true})});if(opened&&media.readyState==='open'){media.addSourceBuffer(attemptedCodec);sourceBufferAccepted=true}}catch{}document.body.textContent=JSON.stringify({source:'browser-false-codec-control',attemptedCodec,supported,sourceBufferAccepted,loadedMetadata:loaded})})()";
const html = '<!doctype html><meta charset="utf-8"><body><script>' + program + '</script>';
const target = 'data:text/html;base64,' + Buffer.from(html).toString('base64');
const result = spawnSync('/opt/google/chrome/google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
  '--virtual-time-budget=5000', '--dump-dom', target,
], { encoding: 'utf8', timeout: 15000, maxBuffer: 262144 });
if (result.status !== 0) process.exit(3);
const match = /<body>([^<]+)<\/body>/.exec(result.stdout || '');
if (!match) process.exit(4);
process.stdout.write(match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
`;
