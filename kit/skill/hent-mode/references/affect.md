# Affect argument for `hent send --affect`

The session states the emotion of each reply itself. `--affect` takes one string:

```
<24 comma-separated integers 0-100>|<confidence 0-100>
```

Values are in the order below. Each integer is divided by 100 before it is sent, so `0` means 0.00 and `100` means 1.00. Confidence uses the same scale. Any other count, a value outside 0-100, or a non-integer is rejected.

## Dimensions (in order)

1. `valence` - how pleasant (positive) or unpleasant (negative) the reply feels.
2. `arousal` - how activated or calm the reply feels.
3. `dominance` - how assertive or submissive the reply feels.
4. `joy` - how much happiness the reply shows.
5. `anger` - how much anger the reply shows.
6. `irritation` - how much mild annoyance the reply shows.
7. `sadness` - how much sorrow the reply shows.
8. `anxiety` - how much worry or unease the reply shows.
9. `fear` - how much fright the reply shows.
10. `surprise` - how much astonishment the reply shows.
11. `confusion` - how much uncertainty or puzzlement the reply shows.
12. `disgust` - how much distaste the reply shows.
13. `embarrassment` - how much self-conscious discomfort the reply shows.
14. `pride` - how much satisfaction in an achievement the reply shows.
15. `determination` - how much resolve or focus the reply shows.
16. `affection` - how much fondness toward the other person the reply shows.
17. `warmth` - how much kindness and closeness the reply conveys.
18. `playfulness` - how much lightheartedness and fun the reply conveys.
19. `teasing` - how much good-natured needling the reply conveys.
20. `deference` - how much respect or yielding to the other person the reply conveys.
21. `smileIntensity` - how strong the smile would be on the face.
22. `browTension` - how much the brows would be drawn together or raised tightly.
23. `eyeOpenness` - how wide the eyes would be open.
24. `bodyOpenness` - how open the posture would be (arms uncrossed, facing forward).

## Example

A warm, happy, mildly playful reply with confidence 0.8:

```
hent send --affect "70,55,50,85,0,0,5,5,0,20,5,0,10,30,40,75,80,70,25,60,80,30,70,75|80"
```
