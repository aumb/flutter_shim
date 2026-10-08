import 'package:flutter/material.dart';

void main() => runApp(const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(backgroundColor: Color(0xFF0B0B0D), body: RowList()),
    ));

/// A plain Flutter scroll view: no 3D scene, just rows of text.
class RowList extends StatelessWidget {
  const RowList({super.key});

  @override
  Widget build(BuildContext context) {
    return ListView.builder(
      itemCount: 2000,
      itemExtent: 84,
      itemBuilder: (context, i) => Container(
        margin: const EdgeInsets.fromLTRB(16, 6, 16, 6),
        padding: const EdgeInsets.only(left: 24),
        alignment: Alignment.centerLeft,
        decoration: BoxDecoration(
          color: i.isOdd ? const Color(0xFF1D1D21) : const Color(0xFF141417),
          border: const Border(left: BorderSide(color: Color(0xFF9A8CFF), width: 6)),
        ),
        child: Text('Row $i', style: const TextStyle(color: Color(0xFFE6E6E8), fontSize: 22)),
      ),
    );
  }
}
