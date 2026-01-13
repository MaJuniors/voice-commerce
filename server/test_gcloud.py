import os
from google.cloud import texttospeech, speech

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "gcloud/key.json"

def test_tts():
    client = texttospeech.TextToSpeechClient()
    synthesis_input = texttospeech.SynthesisInput(text="Halo ini tes TTS Google Cloud")
    voice = texttospeech.VoiceSelectionParams(
        language_code="id-ID",
        ssml_gender=texttospeech.SsmlVoiceGender.NEUTRAL
    )
    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.MP3
    )
    response = client.synthesize_speech(
        input=synthesis_input,
        voice=voice,
        audio_config=audio_config
    )
    with open("tts_test.mp3", "wb") as out:
        out.write(response.audio_content)
    print("TTS OK")

test_tts()
